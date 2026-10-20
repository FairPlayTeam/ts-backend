import { randomUUID } from 'node:crypto';
import { isXmlCompatibleUploadETag } from './validation.js';
import type { Prisma } from '@prisma/client';
import {
  sourceThumbnailSelect,
  lockUploadSession,
  uploadSessionSelect,
  type UploadSessionRecord,
} from './repository.js';
import {
  HOUR_MS,
  VIDEO_UPLOAD_PROGRESS_CHECK_INTERVAL_MS,
  VIDEO_UPLOAD_MIN_PROGRESS_CHECK_INTERVAL_MS,
} from '../../config/constants.js';
import { ObjectStorageUnavailableError } from '../../lib/objectStorage.js';
import { constraintContains, isPrismaUniqueError } from '../../lib/prismaErrors.js';
import { runSerializableTransaction } from '../../lib/prismaTransactions.js';
import { videoOriginalKey, videoSourceThumbnailKey } from '../videos/shared/objectKeys.js';
import { VideoNotFoundError } from '../videos/shared/errors.js';
import {
  EXTERNAL_RESOURCE_QUIESCENCE_MS,
  ExternalResourceSizeMismatchError,
  requestExternalResourceAbsence,
} from '../../services/externalResources.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  VideoStorageQuotaExceededError,
  VideoUploadSessionExpiredError,
  VideoUploadSessionNotFoundError,
  VideoUploadSizeExceededError,
  VideoUploadSizeMismatchError,
  VideoTranscodeAdmissionFullError,
} from './errors.js';
import type { VideoUploadsDependencies } from './dependencies.js';
import {
  createVideoReconciliationHandler,
  createVideoSourceThumbnailReconciliationHandler,
  findActiveUploadSession,
  resetVideoWithoutSourceAfterUploadEnds,
} from './reconciliation.js';
import type {
  AbortVideoMultipartUploadInput,
  CompleteVideoMultipartUploadInput,
  GetVideoMultipartUploadSessionInput,
  InitVideoMultipartUploadInput,
  SignVideoMultipartUploadPartsInput,
  SignVideoMultipartUploadPartsResult,
  UploadVideoSourceThumbnailInput,
  UploadVideoSourceThumbnailResult,
  VideoUploadSession,
  VideoUploadSessionResult,
  VideoUploadsMaintenancePort,
  VideoUploadsPort,
} from './types.js';
import {
  ABORTABLE_UPLOAD_SESSION_STATUSES,
  ACTIVE_UPLOAD_SESSION_STATUSES,
  EXPIRABLE_UPLOAD_SESSION_STATUSES,
  SIGNABLE_UPLOAD_SESSION_STATUSES,
  SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES,
} from './types.js';

type TransactionClient = Prisma.TransactionClient;

const isActiveUploadSessionUniqueConstraintError = (error: unknown): boolean =>
  isPrismaUniqueError(error) &&
  constraintContains(
    error.meta,
    (candidate) =>
      candidate === 'video_id' ||
      candidate.includes('video_upload_sessions_one_active_per_video_key'),
  );

const VIDEO_SOURCE_CONTENT_TYPE = 'video/mp4';
const VIDEO_SOURCE_THUMBNAIL_CACHE_CONTROL = 'private, no-store';
const MULTIPART_MAINTENANCE_BATCH_SIZE = 100;

const bigintToSafeNumber = (value: bigint): number => {
  const numberValue = Number(value);

  if (!Number.isSafeInteger(numberValue)) {
    throw new Error('Persisted video size exceeds the supported JSON integer range');
  }

  return numberValue;
};

const toVideoUploadSession = (session: UploadSessionRecord): VideoUploadSession => ({
  id: session.id,
  videoId: session.videoId,
  userId: session.userId,
  status: session.status,
  bucket: session.bucket,
  objectKey: session.objectKey,
  uploadId: session.multipartHandle?.uploadId ?? null,
  partSizeBytes: session.partSizeBytes,
  expectedSizeBytes: bigintToSafeNumber(session.expectedSizeBytes),
  partCount: session.partCount,
  expiresAt: session.expiresAt,
  completedAt: session.completedAt,
  abortedAt: session.abortedAt,
  expiredAt: session.expiredAt,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  parts: session.parts,
});

const toVideoUploadSessionResult = (session: UploadSessionRecord): VideoUploadSessionResult => ({
  uploadSession: toVideoUploadSession(session),
});

const toUploadVideoSourceThumbnailResult = (
  thumbnail: Prisma.VideoSourceThumbnailGetPayload<{
    select: typeof sourceThumbnailSelect;
  }>,
): UploadVideoSourceThumbnailResult => ({
  thumbnail,
});

const findOwnedUploadSession = async (
  store: Pick<TransactionClient, 'videoUploadSession'>,
  input: GetVideoMultipartUploadSessionInput,
): Promise<UploadSessionRecord> => {
  const session = await store.videoUploadSession.findFirst({
    where: {
      id: input.uploadSessionId,
      videoId: input.videoId,
      userId: input.userId,
      user: { is: { isBanned: false } },
    },
    select: uploadSessionSelect,
  });

  if (!session) {
    throw new VideoUploadSessionNotFoundError();
  }

  return session;
};

const expireStaleUploadSessions = async (
  store: Pick<
    TransactionClient,
    '$queryRaw' | 'externalResourceTarget' | 'video' | 'videoUploadSession'
  >,
  now: Date,
  {
    limit,
    videoId,
  }: {
    limit?: number;
    videoId?: string;
  } = {},
): Promise<number> => {
  const staleSessions = await store.videoUploadSession.findMany({
    where: {
      ...(videoId ? { videoId } : {}),
      status: {
        in: [...EXPIRABLE_UPLOAD_SESSION_STATUSES],
      },
      expiresAt: {
        lte: now,
      },
    },
    select: {
      id: true,
      videoId: true,
      externalResourceTargetId: true,
      sourceThumbnail: {
        select: {
          externalResourceTargetId: true,
        },
      },
    },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    ...(limit === undefined ? {} : { take: limit }),
  });
  const affectedVideoIds = new Set<string>();
  let uploadSessionsExpired = 0;

  for (const session of staleSessions) {
    await lockUploadSession(store, session.id);
    const result = await store.videoUploadSession.updateMany({
      where: {
        id: session.id,
        status: {
          in: [...EXPIRABLE_UPLOAD_SESSION_STATUSES],
        },
        expiresAt: {
          lte: now,
        },
      },
      data: {
        status: 'expiring',
      },
    });

    if (result.count > 0) {
      await requestExternalResourceAbsence(store, session.externalResourceTargetId, now);
      if (session.sourceThumbnail) {
        await requestExternalResourceAbsence(
          store,
          session.sourceThumbnail.externalResourceTargetId,
          now,
        );
      }
      affectedVideoIds.add(session.videoId);
      uploadSessionsExpired += 1;
    }
  }

  for (const affectedVideoId of affectedVideoIds) {
    await resetVideoWithoutSourceAfterUploadEnds(store, affectedVideoId);
  }

  return uploadSessionsExpired;
};

const expireSessionIfNeeded = async (
  deps: VideoUploadsDependencies,
  session: UploadSessionRecord,
  now: Date,
): Promise<UploadSessionRecord> => {
  if (!EXPIRABLE_UPLOAD_SESSION_STATUSES.includes(session.status) || session.expiresAt > now) {
    return session;
  }

  await runSerializableTransaction(deps.prisma, async (tx) => {
    await expireStaleUploadSessions(tx, now, {
      videoId: session.videoId,
    });
  });

  return findOwnedUploadSession(deps.prisma, {
    uploadSessionId: session.id,
    userId: session.userId,
    videoId: session.videoId,
  });
};

const assertSignableUploadSession = (
  session: UploadSessionRecord,
  now: Date,
): UploadSessionRecord & { multipartHandle: { uploadId: string } } => {
  if (
    session.status === 'expiring' ||
    session.status === 'expired' ||
    (EXPIRABLE_UPLOAD_SESSION_STATUSES.includes(session.status) && session.expiresAt <= now)
  ) {
    throw new VideoUploadSessionExpiredError();
  }
  if (!SIGNABLE_UPLOAD_SESSION_STATUSES.includes(session.status) || !session.multipartHandle) {
    throw new InvalidVideoUploadSessionStateError();
  }
  if (session.externalResourceTarget.goal !== 'present')
    throw new InvalidVideoUploadSessionStateError();
  return { ...session, multipartHandle: session.multipartHandle };
};

const getSignableUploadSession = async (
  deps: VideoUploadsDependencies,
  input: GetVideoMultipartUploadSessionInput,
): Promise<UploadSessionRecord & { multipartHandle: { uploadId: string } }> => {
  const session = await expireSessionIfNeeded(
    deps,
    await findOwnedUploadSession(deps.prisma, input),
    deps.clock.now(),
  );

  return assertSignableUploadSession(session, deps.clock.now());
};

const expectedPartCount = (
  session: Pick<UploadSessionRecord, 'expectedSizeBytes' | 'partSizeBytes'>,
) => Math.ceil(bigintToSafeNumber(session.expectedSizeBytes) / session.partSizeBytes);

const assertValidPartNumbers = (
  partNumbers: readonly number[],
  session: Pick<UploadSessionRecord, 'expectedSizeBytes' | 'partSizeBytes'>,
): void => {
  const maxPartNumber = expectedPartCount(session);
  const uniquePartNumbers = new Set(partNumbers);

  if (
    partNumbers.length === 0 ||
    partNumbers.length > 100 ||
    uniquePartNumbers.size !== partNumbers.length ||
    partNumbers.some(
      (partNumber) =>
        !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > maxPartNumber,
    )
  ) {
    throw new InvalidVideoUploadSessionStateError();
  }
};

const sortUploadParts = (
  parts: readonly CompleteVideoMultipartUploadInput['parts'][number][],
): CompleteVideoMultipartUploadInput['parts'] =>
  [...parts].sort((left, right) => left.partNumber - right.partNumber);

const assertValidCompletedParts = (
  parts: readonly CompleteVideoMultipartUploadInput['parts'][number][],
  session: Pick<UploadSessionRecord, 'expectedSizeBytes' | 'partSizeBytes'>,
): CompleteVideoMultipartUploadInput['parts'] => {
  const sortedParts = sortUploadParts(parts);
  const requiredPartCount = expectedPartCount(session);

  if (
    sortedParts.length !== requiredPartCount ||
    sortedParts.some(
      (part, index) =>
        part.partNumber !== index + 1 ||
        part.etag.trim().length === 0 ||
        !isXmlCompatibleUploadETag(part.etag),
    )
  ) {
    throw new InvalidVideoUploadSessionStateError();
  }

  return sortedParts;
};

const partsMatch = (
  persisted: readonly { partNumber: number; etag: string }[],
  requested: readonly { partNumber: number; etag: string }[],
): boolean =>
  persisted.length === requested.length &&
  persisted.every(
    (part, index) =>
      part.partNumber === requested[index]?.partNumber && part.etag === requested[index]?.etag,
  );

const assertUserStorageQuota = async (
  store: Pick<TransactionClient, 'externalResourceTarget'>,
  userId: string,
  sizeBytes: number,
  userStorageQuotaBytes: number,
): Promise<void> => {
  const usage = await store.externalResourceTarget.aggregate({
    where: {
      userId,
      role: {
        in: ['source', 'source_thumbnail'],
      },
      state: {
        not: 'confirmed_absent',
      },
    },
    _sum: {
      expectedSizeBytes: true,
    },
  });
  const reservedBytes = usage._sum.expectedSizeBytes ?? 0n;

  if (reservedBytes + BigInt(sizeBytes) > BigInt(userStorageQuotaBytes)) {
    throw new VideoStorageQuotaExceededError();
  }
};

const assertVideoTranscodeAdmissionCapacity = async (
  tx: Pick<TransactionClient, 'videoTranscodeJob' | 'videoUploadSession'>,
  userId: string,
  {
    maxTranscodeOutstandingJobs,
    maxTranscodeOutstandingJobsPerUser,
  }: Pick<
    VideoUploadsDependencies['config'],
    'maxTranscodeOutstandingJobs' | 'maxTranscodeOutstandingJobsPerUser'
  >,
): Promise<void> => {
  // An expired timestamp never releases capacity before the durable abandonment commits.
  const activeUploadSessionWhere: Prisma.VideoUploadSessionWhereInput = {
    status: { in: [...ACTIVE_UPLOAD_SESSION_STATUSES] },
  };
  const outstandingJobWhere: Prisma.VideoTranscodeJobWhereInput = {
    status: { in: ['queued', 'processing'] },
  };
  const [userJobCount, userSessionCount, totalJobCount, totalSessionCount] = await Promise.all([
    tx.videoTranscodeJob.count({
      where: {
        ...outstandingJobWhere,
        video: { is: { ownerId: userId } },
      },
    }),
    tx.videoUploadSession.count({
      where: { ...activeUploadSessionWhere, userId },
    }),
    tx.videoTranscodeJob.count({ where: outstandingJobWhere }),
    tx.videoUploadSession.count({ where: activeUploadSessionWhere }),
  ]);

  if (
    userJobCount + userSessionCount >= maxTranscodeOutstandingJobsPerUser ||
    totalJobCount + totalSessionCount >= maxTranscodeOutstandingJobs
  ) {
    throw new VideoTranscodeAdmissionFullError();
  }
};

const scheduleFailedInitialization = async (
  deps: VideoUploadsDependencies,
  {
    sessionId,
    targetId,
    uploadId,
  }: {
    sessionId: string;
    targetId: string;
    uploadId: string | null;
  },
): Promise<void> => {
  const now = deps.clock.now();

  await runSerializableTransaction(deps.prisma, async (tx) => {
    const result = await tx.videoUploadSession.updateMany({
      where: {
        id: sessionId,
        status: 'initializing',
      },
      data: {
        status: 'aborting',
      },
    });

    if (uploadId) {
      // A late CreateMultipartUpload response must remain tracked even if the
      // session has already expired or its account/video has been deleted.
      await tx.externalMultipartHandle.upsert({
        where: { targetId_uploadId: { targetId, uploadId } },
        create: {
          targetId,
          ...(result.count > 0 ? { uploadSessionId: sessionId } : {}),
          uploadId,
        },
        update: {},
      });
    }

    if (result.count === 0) {
      if (uploadId) {
        const target = await tx.externalResourceTarget.findUnique({
          where: { id: targetId },
          select: { goal: true },
        });
        if (target?.goal === 'absent') {
          // A newly observed external write invalidates even an older absence confirmation.
          await requestExternalResourceAbsence(tx, targetId, now, { reopenConfirmedAbsence: true });
        }
      }
      return;
    }

    await requestExternalResourceAbsence(tx, targetId, now);
    const session = await tx.videoUploadSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { videoId: true },
    });
    await resetVideoWithoutSourceAfterUploadEnds(tx, session.videoId);
  });
};

const prepareCompletion = async (
  deps: VideoUploadsDependencies,
  session: UploadSessionRecord,
  parts: readonly CompleteVideoMultipartUploadInput['parts'][number][],
): Promise<UploadSessionRecord> => {
  assertValidCompletedParts(parts, session);
  return runSerializableTransaction(deps.prisma, async (tx) => {
    await lockUploadSession(tx, session.id);
    const current = await findOwnedUploadSession(tx, {
      uploadSessionId: session.id,
      videoId: session.videoId,
      userId: session.userId,
    });
    const sortedParts = assertValidCompletedParts(parts, current);
    if (current.status === 'completed' || current.status === 'completing') {
      if (
        (current.status === 'completing' && !current.multipartHandle) ||
        !partsMatch(current.parts, sortedParts)
      ) {
        throw new InvalidVideoUploadSessionStateError();
      }
      return current;
    }
    assertSignableUploadSession(current, deps.clock.now());
    const updated = await tx.videoUploadSession.updateMany({
      where: {
        id: session.id,
        status: {
          in: [...SIGNABLE_UPLOAD_SESSION_STATUSES],
        },
      },
      data: {
        status: 'completing',
      },
    });

    if (updated.count === 0) {
      throw new InvalidVideoUploadSessionStateError();
    }

    await tx.videoUploadPart.createMany({
      data: sortedParts.map((part) => ({
        uploadSessionId: session.id,
        partNumber: part.partNumber,
        etag: part.etag,
      })),
      skipDuplicates: true,
    });
    await tx.externalResourceTarget.updateMany({
      where: {
        id: session.externalResourceTargetId,
        goal: 'present',
        state: 'writing',
      },
      data: {
        nextAttemptAt: deps.clock.now(),
      },
    });
    return findOwnedUploadSession(tx, {
      uploadSessionId: session.id,
      videoId: session.videoId,
      userId: session.userId,
    });
  });
};

const scheduleVideoSourceThumbnailAbsence = async (
  deps: VideoUploadsDependencies,
  targetId: string,
): Promise<void> => {
  const requestedAt = deps.clock.now();

  await runSerializableTransaction(deps.prisma, async (tx) => {
    // This follows a returned PUT, so an earlier absence confirmation is stale.
    await requestExternalResourceAbsence(tx, targetId, requestedAt, {
      reopenConfirmedAbsence: true,
    });
  });
};

export const createVideoUploadsService = (
  deps: VideoUploadsDependencies,
): VideoUploadsPort & VideoUploadsMaintenancePort => ({
  async resolveOwnedVideoId({ publicId, userId }) {
    const video = await deps.prisma.video.findFirst({
      where: {
        publicId,
        ownerId: userId,
      },
      select: { id: true },
    });

    if (!video) {
      throw new VideoNotFoundError();
    }

    return video.id;
  },

  async initMultipartUpload({
    sizeBytes,
    userId,
    videoId,
  }: InitVideoMultipartUploadInput): Promise<VideoUploadSessionResult> {
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > deps.config.maxUploadBytes
    ) {
      throw new VideoUploadSizeExceededError();
    }

    const uploadSessionId = randomUUID();
    const objectKey = videoOriginalKey(userId, videoId, uploadSessionId);
    let reservedSession: { externalResourceTargetId: string };

    try {
      reservedSession = await runSerializableTransaction(deps.prisma, async (tx) => {
        const video = await tx.video.findFirst({
          where: {
            id: videoId,
            ownerId: userId,
            owner: { is: { isBanned: false } },
          },
          select: {
            id: true,
          },
        });

        if (!video) {
          throw new VideoNotFoundError();
        }

        await expireStaleUploadSessions(tx, deps.clock.now(), {
          limit: MULTIPART_MAINTENANCE_BATCH_SIZE,
        });

        if (await findActiveUploadSession(tx, videoId)) {
          throw new ActiveVideoUploadSessionExistsError();
        }

        await assertVideoTranscodeAdmissionCapacity(tx, userId, deps.config);
        await assertUserStorageQuota(tx, userId, sizeBytes, deps.config.userStorageQuotaBytes);

        const now = deps.clock.now();
        const reservations = await tx.externalResourceTarget.count({
          where: { userId, role: 'source', createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
        });
        if (reservations >= deps.config.maxReservationsPerHour) {
          throw new VideoTranscodeAdmissionFullError();
        }
        const hardExpiresAt = new Date(now.getTime() + deps.config.sessionTtlSeconds * 1000);
        const expiresAt = new Date(
          Math.min(hardExpiresAt.getTime(), now.getTime() + deps.config.idleTtlSeconds * 1000),
        );

        const target = await tx.externalResourceTarget.create({
          data: {
            userId,
            videoId,
            bucket: deps.objectStorage.bucket,
            selector: objectKey,
            selectorKind: 'exact',
            role: 'source',
            generation: uploadSessionId,
            expectedSizeBytes: BigInt(sizeBytes),
            mayHaveMultipartUpload: true,
            createdAt: now,
            goal: 'present',
            state: 'writing',
            nextAttemptAt: new Date(now.getTime() + HOUR_MS),
          },
          select: {
            id: true,
          },
        });
        const session = await tx.videoUploadSession.create({
          data: {
            id: uploadSessionId,
            videoId,
            userId,
            status: 'initializing',
            bucket: deps.objectStorage.bucket,
            objectKey,
            partSizeBytes: deps.config.partSizeBytes,
            expectedSizeBytes: BigInt(sizeBytes),
            expiresAt,
            hardExpiresAt,
            nextProgressCheckAt: now,
            externalResourceTargetId: target.id,
          },
          select: {
            externalResourceTargetId: true,
          },
        });

        await tx.video.updateMany({
          where: {
            id: videoId,
            ownerId: userId,
            sourceObjectKey: null,
          },
          data: {
            processingStatus: 'uploading',
          },
        });

        return session;
      });
    } catch (err) {
      if (isActiveUploadSessionUniqueConstraintError(err)) {
        throw new ActiveVideoUploadSessionExistsError();
      }

      throw err;
    }

    let uploadId: string | null = null;

    try {
      const multipart = await deps.objectStorage.initiateMultipartUpload({
        objectKey,
        contentType: VIDEO_SOURCE_CONTENT_TYPE,
      });
      uploadId = multipart.uploadId;

      await deps.prisma.$transaction(async (tx) => {
        await lockUploadSession(tx, uploadSessionId);
        const updated = await tx.videoUploadSession.updateMany({
          where: {
            id: uploadSessionId,
            status: 'initializing',
            expiresAt: { gt: deps.clock.now() },
          },
          data: {
            status: 'initiated',
          },
        });

        if (updated.count === 0) {
          throw new InvalidVideoUploadSessionStateError();
        }

        await tx.externalMultipartHandle.create({
          data: {
            targetId: reservedSession.externalResourceTargetId,
            uploadSessionId,
            uploadId: multipart.uploadId,
          },
        });
      });
      const initiatedSession = await findOwnedUploadSession(deps.prisma, {
        uploadSessionId,
        userId,
        videoId,
      });

      return toVideoUploadSessionResult(initiatedSession);
    } catch (err) {
      await scheduleFailedInitialization(deps, {
        sessionId: uploadSessionId,
        targetId: reservedSession.externalResourceTargetId,
        uploadId,
      }).catch((cleanupError: unknown) => {
        deps.logger.warn(
          { err: cleanupError, uploadSessionId },
          'Failed to schedule cleanup after multipart initialization failure',
        );
      });

      throw err;
    }
  },

  async uploadSourceThumbnail({
    file,
    uploadSessionId,
    userId,
    videoId,
  }: UploadVideoSourceThumbnailInput): Promise<UploadVideoSourceThumbnailResult> {
    const existingSession = await expireSessionIfNeeded(
      deps,
      await findOwnedUploadSession(deps.prisma, {
        uploadSessionId,
        userId,
        videoId,
      }),
      deps.clock.now(),
    );

    if (existingSession.status === 'expiring' || existingSession.status === 'expired') {
      throw new VideoUploadSessionExpiredError();
    }

    if (!SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES.includes(existingSession.status)) {
      throw new InvalidVideoUploadSessionStateError();
    }

    const processedThumbnail = await deps.imageProcessor.processVideoThumbnail(file);
    const thumbnailId = randomUUID();
    const objectKey = videoSourceThumbnailKey(userId, videoId, uploadSessionId, thumbnailId);
    const target = await runSerializableTransaction(deps.prisma, async (tx) => {
      await lockUploadSession(tx, uploadSessionId);
      const currentSession = await tx.videoUploadSession.findFirst({
        where: {
          id: uploadSessionId,
          userId,
          videoId,
        },
        select: {
          expiresAt: true,
          status: true,
        },
      });

      if (!currentSession) {
        throw new VideoUploadSessionNotFoundError();
      }

      const reservedAt = deps.clock.now();
      if (
        currentSession.expiresAt <= reservedAt ||
        !SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES.includes(currentSession.status)
      ) {
        throw new InvalidVideoUploadSessionStateError();
      }

      await assertUserStorageQuota(
        tx,
        userId,
        processedThumbnail.sizeBytes,
        deps.config.userStorageQuotaBytes,
      );

      return tx.externalResourceTarget.create({
        data: {
          userId,
          videoId,
          bucket: deps.objectStorage.bucket,
          selector: objectKey,
          selectorKind: 'exact',
          role: 'source_thumbnail',
          generation: uploadSessionId,
          expectedSizeBytes: BigInt(processedThumbnail.sizeBytes),
          mayHaveMultipartUpload: false,
          goal: 'present',
          state: 'writing',
          nextAttemptAt: new Date(reservedAt.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS),
        },
        select: {
          id: true,
        },
      });
    });

    try {
      await deps.objectStorage.putObject({
        bucket: deps.objectStorage.bucket,
        objectKey,
        body: processedThumbnail.buffer,
        contentType: processedThumbnail.mimeType,
        cacheControl: VIDEO_SOURCE_THUMBNAIL_CACHE_CONTROL,
      });
    } catch (err) {
      await scheduleVideoSourceThumbnailAbsence(deps, target.id).catch((cleanupError: unknown) => {
        deps.logger.warn(
          { err: cleanupError, objectKey, targetId: target.id, uploadSessionId },
          'Failed to schedule video source thumbnail cleanup after PUT failure',
        );
      });
      throw err;
    }

    const madeImmediatelyReconcilable = await deps.prisma.externalResourceTarget.updateMany({
      where: {
        id: target.id,
        goal: 'present',
        state: 'writing',
      },
      data: {
        nextAttemptAt: deps.clock.now(),
      },
    });

    if (madeImmediatelyReconcilable.count !== 1) {
      await scheduleVideoSourceThumbnailAbsence(deps, target.id);
      throw new InvalidVideoUploadSessionStateError();
    }

    let reconciliationResult: Awaited<
      ReturnType<VideoUploadsDependencies['externalResources']['reconcileTarget']>
    >;

    try {
      reconciliationResult = await deps.externalResources.reconcileTarget({
        targetId: target.id,
        roles: ['source_thumbnail'],
        handlers: {
          source_thumbnail: createVideoSourceThumbnailReconciliationHandler(deps),
        },
      });
    } catch (err) {
      if (err instanceof ObjectStorageUnavailableError) {
        throw err;
      }

      throw new ObjectStorageUnavailableError('Video source thumbnail could not be reconciled', {
        cause: err,
      });
    }

    if (reconciliationResult === 'redirected_absent') {
      throw new InvalidVideoUploadSessionStateError();
    }

    if (reconciliationResult !== 'confirmed') {
      throw new ObjectStorageUnavailableError('Video source thumbnail reconciliation is deferred');
    }

    const thumbnail = await deps.prisma.videoSourceThumbnail.findFirst({
      where: {
        uploadSessionId,
        externalResourceTargetId: target.id,
      },
      select: sourceThumbnailSelect,
    });

    if (!thumbnail) {
      throw new InvalidVideoUploadSessionStateError();
    }

    return toUploadVideoSourceThumbnailResult(thumbnail);
  },

  async signMultipartUploadParts({
    partNumbers,
    uploadSessionId,
    userId,
    videoId,
  }: SignVideoMultipartUploadPartsInput): Promise<SignVideoMultipartUploadPartsResult> {
    const input = {
      uploadSessionId,
      userId,
      videoId,
    };
    assertValidPartNumbers(partNumbers, await getSignableUploadSession(deps, input));
    const observation = await runSerializableTransaction(deps.prisma, async (tx) => {
      await lockUploadSession(tx, uploadSessionId);
      const current = assertSignableUploadSession(
        await findOwnedUploadSession(tx, input),
        deps.clock.now(),
      );
      const now = deps.clock.now();
      const checkProgress = current.nextProgressCheckAt <= now;
      // Leave another check opportunity near expiry while retaining a persisted cost bound.
      // Never shorten an already reserved cooldown: another process may be observing S3.
      const checkIntervalMs = Math.max(
        VIDEO_UPLOAD_MIN_PROGRESS_CHECK_INTERVAL_MS,
        Math.min(
          VIDEO_UPLOAD_PROGRESS_CHECK_INTERVAL_MS,
          Math.floor((current.expiresAt.getTime() - now.getTime()) / 2),
        ),
      );
      await tx.videoUploadSession.update({
        where: { id: current.id },
        data: {
          status: 'uploading',
          ...(checkProgress
            ? {
                nextProgressCheckAt: new Date(now.getTime() + checkIntervalMs),
              }
            : {}),
        },
      });
      return { session: current, checkProgress };
    });

    if (observation.checkProgress) {
      const observedSession = observation.session;
      const listed = await deps.objectStorage.listMultipartUploadParts({
        bucket: observedSession.bucket,
        objectKey: observedSession.objectKey,
        uploadId: observedSession.multipartHandle.uploadId,
        limit: expectedPartCount(observedSession),
      });
      if (listed.truncated)
        throw new ObjectStorageUnavailableError('Multipart progress listing was truncated');
      let usefulBytes = 0n;
      const seen = new Set<number>();
      const size = bigintToSafeNumber(observedSession.expectedSizeBytes);
      for (const part of listed.parts) {
        if (seen.has(part.partNumber))
          throw new ObjectStorageUnavailableError('Multipart progress contained duplicate parts');
        seen.add(part.partNumber);
        if (
          !Number.isSafeInteger(part.partNumber) ||
          part.partNumber < 1 ||
          part.partNumber > expectedPartCount(observedSession)
        )
          continue;
        const expected = Math.min(
          observedSession.partSizeBytes,
          size - (part.partNumber - 1) * observedSession.partSizeBytes,
        );
        if (part.sizeBytes === expected) usefulBytes += BigInt(expected);
      }
      await runSerializableTransaction(deps.prisma, async (tx) => {
        await lockUploadSession(tx, uploadSessionId);
        const current = assertSignableUploadSession(
          await findOwnedUploadSession(tx, input),
          deps.clock.now(),
        );
        if (usefulBytes > current.verifiedUploadedBytes) {
          const expiresAt = new Date(
            Math.max(
              current.expiresAt.getTime(),
              Math.min(
                current.hardExpiresAt.getTime(),
                deps.clock.now().getTime() + deps.config.idleTtlSeconds * 1000,
              ),
            ),
          );
          await tx.videoUploadSession.update({
            where: { id: current.id },
            data: { verifiedUploadedBytes: usefulBytes, expiresAt },
          });
        }
      });
    }

    const session = await getSignableUploadSession(deps, input);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await deps.objectStorage.signMultipartUploadPart({
          bucket: session.bucket,
          objectKey: session.objectKey,
          uploadId: session.multipartHandle.uploadId,
          partNumber,
          expiresAt: session.expiresAt,
        }),
      })),
    );
    const checked = await runSerializableTransaction(deps.prisma, async (tx) => {
      await lockUploadSession(tx, uploadSessionId);
      return assertSignableUploadSession(await findOwnedUploadSession(tx, input), deps.clock.now());
    });

    return {
      uploadSessionId: session.id,
      expiresAt: checked.expiresAt,
      parts,
    };
  },

  async completeMultipartUpload({
    parts,
    uploadSessionId,
    userId,
    videoId,
  }: CompleteVideoMultipartUploadInput): Promise<VideoUploadSessionResult> {
    const now = deps.clock.now();
    const existingSession = await expireSessionIfNeeded(
      deps,
      await findOwnedUploadSession(deps.prisma, {
        uploadSessionId,
        userId,
        videoId,
      }),
      now,
    );

    if (existingSession.status === 'expiring' || existingSession.status === 'expired') {
      throw new VideoUploadSessionExpiredError();
    }

    const prepared = await prepareCompletion(deps, existingSession, parts);

    if (prepared.status === 'completed') {
      return toVideoUploadSessionResult(prepared);
    }

    if (!prepared.multipartHandle) {
      throw new InvalidVideoUploadSessionStateError();
    }

    try {
      await deps.externalResources.reconcileTarget({
        targetId: prepared.externalResourceTargetId,
        roles: ['source'],
        handlers: {
          source: createVideoReconciliationHandler(deps),
        },
      });
    } catch (err) {
      if (err instanceof ExternalResourceSizeMismatchError) {
        throw new VideoUploadSizeMismatchError();
      }

      if (err instanceof ObjectStorageUnavailableError) {
        throw err;
      }

      throw new ObjectStorageUnavailableError('Completed video source could not be reconciled', {
        cause: err,
      });
    }

    const reconciledSession = await findOwnedUploadSession(deps.prisma, {
      uploadSessionId,
      userId,
      videoId,
    });

    if (reconciledSession.status !== 'completed') {
      if (
        reconciledSession.status === 'aborting' ||
        reconciledSession.status === 'aborted' ||
        reconciledSession.status === 'expiring' ||
        reconciledSession.status === 'expired'
      ) {
        throw new InvalidVideoUploadSessionStateError();
      }
      throw new ObjectStorageUnavailableError('Completed video source reconciliation is deferred');
    }

    return toVideoUploadSessionResult(reconciledSession);
  },

  async abortMultipartUpload({
    uploadSessionId,
    userId,
    videoId,
  }: AbortVideoMultipartUploadInput): Promise<VideoUploadSessionResult> {
    const now = deps.clock.now();

    await runSerializableTransaction(deps.prisma, async (tx) => {
      const currentSession = await tx.videoUploadSession.findFirst({
        where: {
          id: uploadSessionId,
          userId,
          videoId,
        },
        select: {
          externalResourceTargetId: true,
          id: true,
          sourceThumbnail: {
            select: {
              externalResourceTargetId: true,
            },
          },
          status: true,
          videoId: true,
        },
      });

      if (!currentSession) {
        throw new VideoUploadSessionNotFoundError();
      }

      if (
        currentSession.status === 'aborting' ||
        currentSession.status === 'aborted' ||
        currentSession.status === 'expiring' ||
        currentSession.status === 'expired'
      ) {
        return currentSession;
      }

      if (!ABORTABLE_UPLOAD_SESSION_STATUSES.includes(currentSession.status)) {
        throw new InvalidVideoUploadSessionStateError();
      }

      await tx.videoUploadSession.update({
        where: {
          id: currentSession.id,
        },
        data: {
          status: 'aborting',
        },
      });
      await requestExternalResourceAbsence(tx, currentSession.externalResourceTargetId, now);
      if (currentSession.sourceThumbnail) {
        await requestExternalResourceAbsence(
          tx,
          currentSession.sourceThumbnail.externalResourceTargetId,
          now,
        );
      }
      await resetVideoWithoutSourceAfterUploadEnds(tx, videoId);
    });
    const session = await findOwnedUploadSession(deps.prisma, {
      uploadSessionId,
      userId,
      videoId,
    });

    return toVideoUploadSessionResult(session);
  },

  async getMultipartUploadSession(
    input: GetVideoMultipartUploadSessionInput,
  ): Promise<VideoUploadSessionResult> {
    const session = await expireSessionIfNeeded(
      deps,
      await findOwnedUploadSession(deps.prisma, input),
      deps.clock.now(),
    );

    return toVideoUploadSessionResult(session);
  },

  async expireMultipartUploadSessions({ expiredBefore }) {
    const uploadSessionsExpired = await runSerializableTransaction(deps.prisma, (tx) =>
      expireStaleUploadSessions(tx, expiredBefore, {
        limit: MULTIPART_MAINTENANCE_BATCH_SIZE,
      }),
    );

    return { uploadSessionsExpired };
  },
});
