import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { HOUR_MS } from '../../config/constants.js';
import { ObjectStorageUnavailableError } from '../../lib/objectStorage.js';
import { runSerializableTransaction } from '../../lib/prismaTransactions.js';
import { videoOriginalKey } from './videoObjectKeys.js';
import {
  createVideoArtifactReconciliationHandler,
  scheduleAbandonedVideoArtifactGenerations,
} from './videoTranscodeRunner.js';
import type { VideosDependencies } from './videos.dependencies.js';
import {
  ExternalResourceNotDesiredError,
  ExternalResourceSizeMismatchError,
  requestExternalResourceAbsence,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
  type ExternalResourceReconciliationHandler,
} from '../externalResources.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  VideoNotFoundError,
  VideoStorageQuotaExceededError,
  VideoUploadSessionExpiredError,
  VideoUploadSessionNotFoundError,
  VideoUploadSizeExceededError,
  VideoUploadSizeMismatchError,
} from '../videos.errors.js';
import type {
  AbortVideoMultipartUploadInput,
  CompleteVideoMultipartUploadInput,
  CreateVideoInput,
  CreateVideoResult,
  GetVideoMultipartUploadSessionInput,
  InitVideoMultipartUploadInput,
  ListMyVideosInput,
  ListMyVideosResult,
  SignVideoMultipartUploadPartsInput,
  SignVideoMultipartUploadPartsResult,
  VideoUploadSession,
  VideoUploadSessionResult,
  VideosService,
} from './types/ports.types.js';

const ACTIVE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSession['status'][] = [
  'initializing',
  'initiated',
  'uploading',
  'completing',
];
const EXPIRABLE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSession['status'][] = [
  'initializing',
  'initiated',
  'uploading',
];
const SIGNABLE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSession['status'][] = [
  'initiated',
  'uploading',
];
const ABORTABLE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSession['status'][] = [
  'initializing',
  'initiated',
  'uploading',
  'completing',
];
const VIDEO_SOURCE_CONTENT_TYPE = 'video/mp4';
const DEFAULT_MY_VIDEOS_LIMIT = 20;
const MAX_MY_VIDEOS_LIMIT = 100;
const MULTIPART_MAINTENANCE_BATCH_SIZE = 100;
const PUBLIC_ID_MAX_CREATE_ATTEMPTS = 5;

const videoSelect = {
  id: true,
  publicId: true,
  ownerId: true,
  title: true,
  description: true,
  tags: true,
  license: true,
  visibility: true,
  allowComments: true,
  processingStatus: true,
  moderationStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VideoSelect;

const uploadSessionSelect = {
  id: true,
  videoId: true,
  userId: true,
  status: true,
  bucket: true,
  objectKey: true,
  partSizeBytes: true,
  expectedSizeBytes: true,
  partCount: true,
  expiresAt: true,
  completedAt: true,
  abortedAt: true,
  expiredAt: true,
  externalResourceTargetId: true,
  createdAt: true,
  updatedAt: true,
  multipartHandle: {
    select: {
      uploadId: true,
    },
  },
  parts: {
    select: {
      partNumber: true,
      etag: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: {
      partNumber: 'asc',
    },
  },
} satisfies Prisma.VideoUploadSessionSelect;

const reconciliationUploadSessionSelect = {
  id: true,
  videoId: true,
  userId: true,
  status: true,
  bucket: true,
  objectKey: true,
  externalResourceTargetId: true,
  multipartHandle: {
    select: {
      uploadId: true,
    },
  },
  parts: {
    select: {
      partNumber: true,
      etag: true,
    },
    orderBy: {
      partNumber: 'asc',
    },
  },
} satisfies Prisma.VideoUploadSessionSelect;

type UploadSessionRecord = Prisma.VideoUploadSessionGetPayload<{
  select: typeof uploadSessionSelect;
}>;

type ReconciliationUploadSessionRecord = Prisma.VideoUploadSessionGetPayload<{
  select: typeof reconciliationUploadSessionSelect;
}>;

type VideoMetadataRecord = Prisma.VideoGetPayload<{
  select: typeof videoSelect;
}>;

type TransactionClient = Prisma.TransactionClient;

const isUniqueConstraintError = (err: unknown): err is Prisma.PrismaClientKnownRequestError =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const constraintContains = (
  value: unknown,
  matches: (candidate: string) => boolean,
  depth = 3,
): boolean => {
  if (typeof value === 'string') {
    return matches(value);
  }

  if (depth === 0 || typeof value !== 'object' || value === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => constraintContains(item, matches, depth - 1));
  }

  return Object.entries(value).some(
    ([key, nested]) =>
      constraintContains(key, matches, depth - 1) || constraintContains(nested, matches, depth - 1),
  );
};

const isPublicIdUniqueConstraintError = (err: unknown): boolean =>
  isUniqueConstraintError(err) &&
  constraintContains(
    err.meta,
    (candidate) =>
      candidate === 'publicId' || candidate === 'public_id' || candidate.includes('public_id'),
  );

const isActiveUploadSessionUniqueConstraintError = (err: unknown): boolean =>
  isUniqueConstraintError(err) &&
  constraintContains(
    err.meta,
    (candidate) =>
      candidate === 'video_id' ||
      candidate.includes('video_upload_sessions_one_active_per_video_key'),
  );

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

const toCreateVideoResult = (video: VideoMetadataRecord): CreateVideoResult => ({
  video,
});

const normalizeMyVideosLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_MY_VIDEOS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_MY_VIDEOS_LIMIT);
};

const normalizeOptionalDescription = (description: string | null | undefined): string | null => {
  const normalizedDescription = description?.trim();

  return normalizedDescription ? normalizedDescription : null;
};

const findOwnedUploadSession = async (
  store: Pick<TransactionClient, 'videoUploadSession'>,
  input: GetVideoMultipartUploadSessionInput,
): Promise<UploadSessionRecord> => {
  const session = await store.videoUploadSession.findFirst({
    where: {
      id: input.uploadSessionId,
      videoId: input.videoId,
      userId: input.userId,
    },
    select: uploadSessionSelect,
  });

  if (!session) {
    throw new VideoUploadSessionNotFoundError();
  }

  return session;
};

const findActiveUploadSession = (
  store: Pick<TransactionClient, 'videoUploadSession'>,
  videoId: string,
): Promise<{ id: string } | null> =>
  store.videoUploadSession.findFirst({
    where: {
      videoId,
      status: {
        in: [...ACTIVE_UPLOAD_SESSION_STATUSES],
      },
    },
    select: {
      id: true,
    },
  });

const resetVideoWithoutSourceAfterUploadEnds = async (
  store: Pick<TransactionClient, 'video' | 'videoUploadSession'>,
  videoId: string,
): Promise<void> => {
  if (await findActiveUploadSession(store, videoId)) {
    return;
  }

  await store.video.updateMany({
    where: {
      id: videoId,
      sourceObjectKey: null,
      processingStatus: 'uploading',
    },
    data: {
      processingStatus: 'draft',
    },
  });
};

const expireStaleUploadSessions = async (
  store: Pick<TransactionClient, 'externalResourceTarget' | 'video' | 'videoUploadSession'>,
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
    },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    ...(limit === undefined ? {} : { take: limit }),
  });
  const affectedVideoIds = new Set<string>();
  let uploadSessionsExpired = 0;

  for (const session of staleSessions) {
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
  deps: VideosDependencies,
  session: UploadSessionRecord,
  now: Date,
): Promise<UploadSessionRecord> => {
  if (!EXPIRABLE_UPLOAD_SESSION_STATUSES.includes(session.status) || session.expiresAt > now) {
    return session;
  }

  return runSerializableTransaction(deps.prisma, async (tx) => {
    await expireStaleUploadSessions(tx, now, {
      videoId: session.videoId,
    });

    return findOwnedUploadSession(tx, {
      uploadSessionId: session.id,
      userId: session.userId,
      videoId: session.videoId,
    });
  });
};

const getSignableUploadSession = async (
  deps: VideosDependencies,
  input: GetVideoMultipartUploadSessionInput,
): Promise<UploadSessionRecord & { multipartHandle: { uploadId: string } }> => {
  const session = await expireSessionIfNeeded(
    deps,
    await findOwnedUploadSession(deps.prisma, input),
    deps.clock.now(),
  );

  if (session.status === 'expiring' || session.status === 'expired') {
    throw new VideoUploadSessionExpiredError();
  }

  if (!SIGNABLE_UPLOAD_SESSION_STATUSES.includes(session.status) || !session.multipartHandle) {
    throw new InvalidVideoUploadSessionStateError();
  }

  return {
    ...session,
    multipartHandle: session.multipartHandle,
  };
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
    uniquePartNumbers.size !== partNumbers.length ||
    partNumbers.some((partNumber) => partNumber < 1 || partNumber > maxPartNumber)
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
      (part, index) => part.partNumber !== index + 1 || part.etag.trim().length === 0,
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

const assertUploadSizeAndQuota = async (
  store: Pick<TransactionClient, 'externalResourceTarget'>,
  userId: string,
  sizeBytes: number,
  config: Pick<VideosDependencies['config'], 'maxUploadBytes' | 'userStorageQuotaBytes'>,
): Promise<void> => {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > config.maxUploadBytes) {
    throw new VideoUploadSizeExceededError();
  }

  const usage = await store.externalResourceTarget.aggregate({
    where: {
      userId,
      role: 'source',
      state: {
        not: 'confirmed_absent',
      },
    },
    _sum: {
      expectedSizeBytes: true,
    },
  });
  const reservedBytes = usage._sum.expectedSizeBytes ?? 0n;

  if (reservedBytes + BigInt(sizeBytes) > BigInt(config.userStorageQuotaBytes)) {
    throw new VideoStorageQuotaExceededError();
  }
};

const scheduleFailedInitialization = async (
  deps: VideosDependencies,
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

    if (result.count === 0) {
      return;
    }

    if (uploadId) {
      await tx.externalMultipartHandle.create({
        data: {
          targetId,
          uploadSessionId: sessionId,
          uploadId,
        },
      });
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
  deps: VideosDependencies,
  session: UploadSessionRecord,
  parts: readonly CompleteVideoMultipartUploadInput['parts'][number][],
): Promise<UploadSessionRecord> => {
  const sortedParts = assertValidCompletedParts(parts, session);

  if (session.status === 'completed') {
    if (!partsMatch(session.parts, sortedParts)) {
      throw new InvalidVideoUploadSessionStateError();
    }

    return session;
  }

  if (session.status === 'completing') {
    if (!session.multipartHandle || !partsMatch(session.parts, sortedParts)) {
      throw new InvalidVideoUploadSessionStateError();
    }

    return session;
  }

  if (!SIGNABLE_UPLOAD_SESSION_STATUSES.includes(session.status) || !session.multipartHandle) {
    throw new InvalidVideoUploadSessionStateError();
  }

  return deps.prisma.$transaction(async (tx) => {
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
      userId: session.userId,
      videoId: session.videoId,
    });
  });
};

const scheduleSizeMismatchCleanup = async (
  deps: VideosDependencies,
  session: UploadSessionRecord,
): Promise<void> => {
  const now = deps.clock.now();

  await runSerializableTransaction(deps.prisma, async (tx) => {
    const updated = await tx.videoUploadSession.updateMany({
      where: {
        id: session.id,
        status: 'completing',
      },
      data: {
        status: 'aborting',
      },
    });

    if (updated.count === 0) {
      return;
    }

    await requestExternalResourceAbsence(tx, session.externalResourceTargetId, now);
    await resetVideoWithoutSourceAfterUploadEnds(tx, session.videoId);
  });
};

const publishCompletedSourceInTransaction = async (
  tx: TransactionClient,
  session: Pick<
    ReconciliationUploadSessionRecord,
    'externalResourceTargetId' | 'id' | 'objectKey' | 'userId' | 'videoId'
  >,
  sizeBytes: number,
  now: Date,
): Promise<void> => {
  const currentSession = await findOwnedUploadSession(tx, {
    uploadSessionId: session.id,
    userId: session.userId,
    videoId: session.videoId,
  });

  if (currentSession.status === 'completed') {
    return;
  }

  if (currentSession.status !== 'completing') {
    throw new InvalidVideoUploadSessionStateError();
  }

  const video = await tx.video.findFirst({
    where: {
      id: session.videoId,
      ownerId: session.userId,
    },
    select: {
      sourceUploadSession: {
        select: {
          externalResourceTargetId: true,
        },
      },
    },
  });

  if (!video) {
    throw new VideoNotFoundError();
  }

  const previousTargetId = video.sourceUploadSession?.externalResourceTargetId ?? null;

  await tx.videoUploadSession.update({
    where: {
      id: session.id,
    },
    data: {
      status: 'completed',
      partCount: currentSession.parts.length,
      completedAt: now,
    },
  });
  await tx.video.update({
    where: {
      id: session.videoId,
    },
    data: {
      sourceUploadSessionId: session.id,
      sourceObjectKey: session.objectKey,
      sourceSizeBytes: BigInt(sizeBytes),
      processingStatus: 'queued',
      transcodeError: null,
    },
  });
  await tx.videoTranscodeJob.createMany({
    data: [
      {
        videoId: session.videoId,
        status: 'queued',
        sourceObjectKey: session.objectKey,
        nextAttemptAt: now,
      },
    ],
    skipDuplicates: true,
  });

  if (previousTargetId && previousTargetId !== session.externalResourceTargetId) {
    await requestExternalResourceAbsence(tx, previousTargetId, now);
  }
};

const createVideoReconciliationHandler = (
  deps: VideosDependencies,
): ExternalResourceReconciliationHandler => ({
  async preparePresent(target) {
    const session = await deps.prisma.videoUploadSession.findFirst({
      where: {
        externalResourceTargetId: target.id,
      },
      select: reconciliationUploadSessionSelect,
    });

    if (!session) {
      throw new ExternalResourceNotDesiredError('Video source reservation has no upload session');
    }

    if (
      session.status === 'initializing' ||
      session.status === 'aborting' ||
      session.status === 'aborted' ||
      session.status === 'expiring' ||
      session.status === 'expired'
    ) {
      throw new ExternalResourceNotDesiredError('Video source upload is being discarded');
    }

    if (session.status === 'completed') {
      return;
    }

    if (session.status !== 'completing' || !session.multipartHandle) {
      throw new Error('Video source upload is not ready for reconciliation');
    }

    try {
      await deps.objectStorage.completeMultipartUpload({
        bucket: session.bucket,
        objectKey: session.objectKey,
        uploadId: session.multipartHandle.uploadId,
        parts: session.parts,
      });
    } catch (err) {
      const object = await deps.objectStorage.headObject({
        bucket: session.bucket,
        objectKey: session.objectKey,
      });

      if (!object) {
        throw err;
      }
    }
  },

  async handlePresentSizeMismatch(tx, target) {
    const session = await tx.videoUploadSession.findFirst({
      where: {
        externalResourceTargetId: target.id,
        status: 'completing',
      },
      select: {
        id: true,
        videoId: true,
      },
    });

    if (!session) {
      return;
    }

    const updated = await tx.videoUploadSession.updateMany({
      where: {
        id: session.id,
        status: 'completing',
      },
      data: {
        status: 'aborting',
      },
    });

    if (updated.count > 0) {
      await resetVideoWithoutSourceAfterUploadEnds(tx, session.videoId);
    }
  },

  async finalize(tx, target, verifiedObject) {
    const session = await tx.videoUploadSession.findFirst({
      where: {
        externalResourceTargetId: target.id,
      },
      select: reconciliationUploadSessionSelect,
    });

    if (!session) {
      return;
    }

    if (target.goal === 'present') {
      if (!verifiedObject) {
        throw new Error('Verified video source metadata is missing');
      }

      await publishCompletedSourceInTransaction(
        tx,
        session,
        verifiedObject.sizeBytes,
        deps.clock.now(),
      );
      return;
    }

    if (session.status === 'initializing' || session.status === 'aborting') {
      const resetUnfinishedVideo = session.status === 'initializing';

      await tx.videoUploadSession.update({
        where: { id: session.id },
        data: {
          status: 'aborted',
          abortedAt: deps.clock.now(),
        },
      });

      if (resetUnfinishedVideo) {
        await resetVideoWithoutSourceAfterUploadEnds(tx, session.videoId);
      }
    } else if (session.status === 'expiring') {
      await tx.videoUploadSession.update({
        where: { id: session.id },
        data: {
          status: 'expired',
          expiredAt: deps.clock.now(),
        },
      });
    }
  },
});

export const createVideosService = (deps: VideosDependencies): VideosService => ({
  async createVideo({
    allowComments,
    description,
    license,
    tags,
    title,
    userId,
  }: CreateVideoInput): Promise<CreateVideoResult> {
    for (let attempt = 1; attempt <= PUBLIC_ID_MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        const video = await deps.prisma.video.create({
          data: {
            publicId: deps.publicIdGenerator.generate(),
            ownerId: userId,
            title,
            description: normalizeOptionalDescription(description),
            tags,
            license,
            visibility: 'unlisted',
            allowComments,
            processingStatus: 'draft',
            moderationStatus: 'pending',
          },
          select: videoSelect,
        });

        return toCreateVideoResult(video);
      } catch (err) {
        if (!isPublicIdUniqueConstraintError(err) || attempt === PUBLIC_ID_MAX_CREATE_ATTEMPTS) {
          throw err;
        }
      }
    }

    throw new Error('Video public id generation retry loop exhausted unexpectedly');
  },

  async listMyVideos({ cursor, limit, userId }: ListMyVideosInput): Promise<ListMyVideosResult> {
    const pageSize = normalizeMyVideosLimit(limit);
    const resultFilter = {
      ownerId: userId,
    } satisfies Prisma.VideoWhereInput;
    const pageFilter = {
      ...resultFilter,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    } satisfies Prisma.VideoWhereInput;

    const [queriedVideos, total] = await deps.prisma.$transaction([
      deps.prisma.video.findMany({
        where: pageFilter,
        select: videoSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
      }),
      deps.prisma.video.count({
        where: resultFilter,
      }),
    ]);
    const videos = queriedVideos.slice(0, pageSize);
    const lastVideo = videos.at(-1);
    const nextCursor =
      queriedVideos.length > pageSize && lastVideo
        ? { createdAt: lastVideo.createdAt, id: lastVideo.id }
        : null;

    return {
      videos,
      total,
      nextCursor,
    };
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

    const now = deps.clock.now();
    const uploadSessionId = randomUUID();
    const objectKey = videoOriginalKey(userId, videoId, uploadSessionId);
    const expiresAt = new Date(now.getTime() + deps.config.sessionTtlSeconds * 1000);
    let reservedSession: UploadSessionRecord;

    try {
      reservedSession = await runSerializableTransaction(deps.prisma, async (tx) => {
        const video = await tx.video.findFirst({
          where: {
            id: videoId,
            ownerId: userId,
          },
          select: {
            id: true,
          },
        });

        if (!video) {
          throw new VideoNotFoundError();
        }

        await expireStaleUploadSessions(tx, now, { videoId });

        if (await findActiveUploadSession(tx, videoId)) {
          throw new ActiveVideoUploadSessionExistsError();
        }

        await assertUploadSizeAndQuota(tx, userId, sizeBytes, deps.config);

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
            externalResourceTargetId: target.id,
          },
          select: uploadSessionSelect,
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

      const initiatedSession = await deps.prisma.$transaction(async (tx) => {
        const updated = await tx.videoUploadSession.updateMany({
          where: {
            id: uploadSessionId,
            status: 'initializing',
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

        return findOwnedUploadSession(tx, {
          uploadSessionId,
          userId,
          videoId,
        });
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

  async signMultipartUploadParts({
    partNumbers,
    uploadSessionId,
    userId,
    videoId,
  }: SignVideoMultipartUploadPartsInput): Promise<SignVideoMultipartUploadPartsResult> {
    const session = await getSignableUploadSession(deps, {
      uploadSessionId,
      userId,
      videoId,
    });
    assertValidPartNumbers(partNumbers, session);

    if (session.status === 'initiated') {
      await deps.prisma.videoUploadSession.updateMany({
        where: {
          id: session.id,
          status: 'initiated',
        },
        data: {
          status: 'uploading',
        },
      });
    }

    return {
      uploadSessionId: session.id,
      parts: await Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await deps.objectStorage.signMultipartUploadPart({
            bucket: session.bucket,
            objectKey: session.objectKey,
            uploadId: session.multipartHandle.uploadId,
            partNumber,
          }),
        })),
      ),
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
        await scheduleSizeMismatchCleanup(deps, prepared);
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

    const session = await runSerializableTransaction(deps.prisma, async (tx) => {
      const currentSession = await findOwnedUploadSession(tx, {
        uploadSessionId,
        userId,
        videoId,
      });

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
      await resetVideoWithoutSourceAfterUploadEnds(tx, videoId);

      return findOwnedUploadSession(tx, {
        uploadSessionId,
        userId,
        videoId,
      });
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

  async scheduleAbandonedArtifactGenerations({ observedAt }) {
    return scheduleAbandonedVideoArtifactGenerations(
      {
        prisma: deps.prisma,
        clock: deps.clock,
      },
      { observedAt },
    );
  },

  async reconcilePendingExternalResources(input = {}) {
    const artifactHandler = createVideoArtifactReconciliationHandler(deps.clock);

    return deps.externalResources.reconcileDue({
      roles: VIDEO_EXTERNAL_RESOURCE_ROLES,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      handlers: {
        source: createVideoReconciliationHandler(deps),
        hls_artifacts: artifactHandler,
        thumbnail_prefix: artifactHandler,
      },
    });
  },
});
