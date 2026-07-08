import { Prisma } from '@prisma/client';
import { videoOriginalKey } from './videoObjectKeys.js';
import type { VideosDependencies } from './videos.dependencies.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  InvalidVideoUploadStateError,
  VideoNotFoundError,
  VideoUploadSessionExpiredError,
  VideoUploadSessionNotFoundError,
} from '../videos.errors.js';
import type {
  AbortVideoMultipartUploadInput,
  CreateVideoInput,
  CreateVideoResult,
  CompleteVideoMultipartUploadInput,
  GetVideoMultipartUploadSessionInput,
  InitVideoMultipartUploadInput,
  SignVideoMultipartUploadPartsInput,
  SignVideoMultipartUploadPartsResult,
  VideoUploadSession,
  VideoUploadSessionResult,
  VideosPorts,
} from './types/ports.types.js';

const ACTIVE_UPLOAD_SESSION_STATUSES = ['initiated', 'uploading'] as const;
const UPLOADABLE_VIDEO_PROCESSING_STATUSES = ['draft', 'uploading', 'failed'] as const;
const VIDEO_SOURCE_CONTENT_TYPE = 'video/mp4';
const TRANSACTION_MAX_ATTEMPTS = 3;
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
  uploadId: true,
  partSizeBytes: true,
  partCount: true,
  expiresAt: true,
  completedAt: true,
  abortedAt: true,
  createdAt: true,
  updatedAt: true,
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

type UploadSessionRecord = Prisma.VideoUploadSessionGetPayload<{
  select: typeof uploadSessionSelect;
}>;

type VideoMetadataRecord = Prisma.VideoGetPayload<{
  select: typeof videoSelect;
}>;

type VideoRecord = {
  id: string;
  ownerId: string;
  processingStatus: string;
};

type TransactionClient = Parameters<Parameters<VideosDependencies['prisma']['$transaction']>[0]>[0];
type UploadSessionStore = Pick<TransactionClient, 'video' | 'videoUploadSession'>;

const isActiveUploadSessionStatus = (
  status: string,
): status is (typeof ACTIVE_UPLOAD_SESSION_STATUSES)[number] =>
  ACTIVE_UPLOAD_SESSION_STATUSES.includes(
    status as (typeof ACTIVE_UPLOAD_SESSION_STATUSES)[number],
  );

const isTransactionConflictError = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

const isPublicIdUniqueConstraintError = (err: unknown): boolean => {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }

  const target = err.meta?.target;

  if (Array.isArray(target)) {
    return target.includes('publicId') || target.includes('public_id');
  }

  return typeof target === 'string' && target.includes('public');
};

const runSerializableTransaction = async <T>(
  deps: VideosDependencies,
  callback: (tx: TransactionClient) => Promise<T>,
): Promise<T> => {
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await deps.prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      if (!isTransactionConflictError(err) || attempt === TRANSACTION_MAX_ATTEMPTS) {
        throw err;
      }
    }
  }

  throw new Error('Video upload transaction retry loop exhausted unexpectedly');
};

const toVideoUploadSession = (session: UploadSessionRecord): VideoUploadSession => ({
  id: session.id,
  videoId: session.videoId,
  userId: session.userId,
  status: session.status,
  bucket: session.bucket,
  objectKey: session.objectKey,
  uploadId: session.uploadId,
  partSizeBytes: session.partSizeBytes,
  partCount: session.partCount,
  expiresAt: session.expiresAt,
  completedAt: session.completedAt,
  abortedAt: session.abortedAt,
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

const normalizeOptionalDescription = (description: string | null | undefined): string | null => {
  const normalizedDescription = description?.trim();

  return normalizedDescription ? normalizedDescription : null;
};

const assertUploadableVideo = (video: VideoRecord): void => {
  if (
    !UPLOADABLE_VIDEO_PROCESSING_STATUSES.includes(
      video.processingStatus as (typeof UPLOADABLE_VIDEO_PROCESSING_STATUSES)[number],
    )
  ) {
    throw new InvalidVideoUploadStateError();
  }
};

const findOwnedVideo = async (
  store: Pick<VideosDependencies['prisma'], 'video'>,
  userId: string,
  videoId: string,
): Promise<VideoRecord> => {
  const video = await store.video.findFirst({
    where: {
      id: videoId,
      ownerId: userId,
    },
    select: {
      id: true,
      ownerId: true,
      processingStatus: true,
    },
  });

  if (!video) {
    throw new VideoNotFoundError();
  }

  return video;
};

const expireStaleUploadSessions = (
  store: Pick<UploadSessionStore, 'videoUploadSession'>,
  now: Date,
  videoId: string,
): Promise<unknown> =>
  store.videoUploadSession.updateMany({
    where: {
      videoId,
      status: {
        in: [...ACTIVE_UPLOAD_SESSION_STATUSES],
      },
      expiresAt: {
        lte: now,
      },
    },
    data: {
      status: 'expired',
    },
  });

const findActiveUploadSession = (
  store: Pick<UploadSessionStore, 'videoUploadSession'>,
  now: Date,
  videoId: string,
): Promise<{ id: string } | null> =>
  store.videoUploadSession.findFirst({
    where: {
      videoId,
      status: {
        in: [...ACTIVE_UPLOAD_SESSION_STATUSES],
      },
      expiresAt: {
        gt: now,
      },
    },
    select: {
      id: true,
    },
  });

const findOwnedUploadSession = async (
  store: Pick<VideosDependencies['prisma'], 'videoUploadSession'>,
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

const expireSessionIfNeeded = async (
  deps: VideosDependencies,
  session: UploadSessionRecord,
  now: Date,
): Promise<UploadSessionRecord> => {
  if (!isActiveUploadSessionStatus(session.status) || session.expiresAt > now) {
    return session;
  }

  return deps.prisma.videoUploadSession.update({
    where: {
      id: session.id,
    },
    data: {
      status: 'expired',
    },
    select: uploadSessionSelect,
  });
};

const getActiveUploadSession = async (
  deps: VideosDependencies,
  input: GetVideoMultipartUploadSessionInput,
): Promise<UploadSessionRecord> => {
  const now = deps.clock.now();
  const session = await expireSessionIfNeeded(
    deps,
    await findOwnedUploadSession(deps.prisma, input),
    now,
  );

  if (session.status === 'expired') {
    throw new VideoUploadSessionExpiredError();
  }

  if (!isActiveUploadSessionStatus(session.status)) {
    throw new InvalidVideoUploadSessionStateError();
  }

  return session;
};

const assertValidPartNumbers = (partNumbers: readonly number[], maxPartCount: number): void => {
  const uniquePartNumbers = new Set(partNumbers);

  if (
    partNumbers.length === 0 ||
    uniquePartNumbers.size !== partNumbers.length ||
    partNumbers.some((partNumber) => partNumber < 1 || partNumber > maxPartCount)
  ) {
    throw new InvalidVideoUploadSessionStateError();
  }
};

const assertValidCompletedParts = (
  parts: readonly CompleteVideoMultipartUploadInput['parts'][number][],
  maxPartCount: number,
): void => {
  assertValidPartNumbers(
    parts.map((part) => part.partNumber),
    maxPartCount,
  );

  if (parts.some((part) => part.etag.trim() === '')) {
    throw new InvalidVideoUploadSessionStateError();
  }
};

const sortUploadParts = (
  parts: readonly CompleteVideoMultipartUploadInput['parts'][number][],
): CompleteVideoMultipartUploadInput['parts'] =>
  [...parts].sort((left, right) => left.partNumber - right.partNumber);

export const createVideosService = (deps: VideosDependencies): VideosPorts => ({
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

  async initMultipartUpload({
    userId,
    videoId,
  }: InitVideoMultipartUploadInput): Promise<VideoUploadSessionResult> {
    const now = deps.clock.now();
    const video = await findOwnedVideo(deps.prisma, userId, videoId);
    assertUploadableVideo(video);
    await expireStaleUploadSessions(deps.prisma, now, videoId);

    if (await findActiveUploadSession(deps.prisma, now, videoId)) {
      throw new ActiveVideoUploadSessionExistsError();
    }

    const objectKey = videoOriginalKey(userId, videoId);
    const { uploadId } = await deps.objectStorage.initiateMultipartUpload({
      objectKey,
      contentType: VIDEO_SOURCE_CONTENT_TYPE,
    });
    const expiresAt = new Date(now.getTime() + deps.config.sessionTtlSeconds * 1000);

    try {
      const session = await runSerializableTransaction(deps, async (tx) => {
        await expireStaleUploadSessions(tx, now, videoId);
        assertUploadableVideo(await findOwnedVideo(tx, userId, videoId));

        if (await findActiveUploadSession(tx, now, videoId)) {
          throw new ActiveVideoUploadSessionExistsError();
        }

        await tx.video.update({
          where: {
            id: videoId,
          },
          data: {
            processingStatus: 'uploading',
          },
        });

        return tx.videoUploadSession.create({
          data: {
            videoId,
            userId,
            status: 'initiated',
            bucket: deps.objectStorage.bucket,
            objectKey,
            uploadId,
            partSizeBytes: deps.config.partSizeBytes,
            expiresAt,
          },
          select: uploadSessionSelect,
        });
      });

      return toVideoUploadSessionResult(session);
    } catch (err) {
      await deps.objectStorage.abortMultipartUpload({ objectKey, uploadId }).catch(() => undefined);
      throw err;
    }
  },

  async signMultipartUploadParts({
    partNumbers,
    uploadSessionId,
    userId,
    videoId,
  }: SignVideoMultipartUploadPartsInput): Promise<SignVideoMultipartUploadPartsResult> {
    assertValidPartNumbers(partNumbers, deps.config.maxPartCount);
    const session = await getActiveUploadSession(deps, { uploadSessionId, userId, videoId });

    if (session.status === 'initiated') {
      await deps.prisma.videoUploadSession.update({
        where: {
          id: session.id,
        },
        data: {
          status: 'uploading',
        },
        select: {
          id: true,
        },
      });
    }

    return {
      uploadSessionId: session.id,
      parts: await Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await deps.objectStorage.signMultipartUploadPart({
            objectKey: session.objectKey,
            uploadId: session.uploadId,
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
    const existingSession = await findOwnedUploadSession(deps.prisma, {
      uploadSessionId,
      userId,
      videoId,
    });

    if (existingSession.status === 'completed') {
      return toVideoUploadSessionResult(existingSession);
    }

    assertValidCompletedParts(parts, deps.config.maxPartCount);
    const session = await getActiveUploadSession(deps, { uploadSessionId, userId, videoId });
    const sortedParts = sortUploadParts(parts);

    await deps.objectStorage.completeMultipartUpload({
      objectKey: session.objectKey,
      uploadId: session.uploadId,
      parts: sortedParts,
    });

    const now = deps.clock.now();
    const completedSession = await runSerializableTransaction(deps, async (tx) => {
      const updatedSession = await tx.videoUploadSession.update({
        where: {
          id: session.id,
        },
        data: {
          status: 'completed',
          partCount: sortedParts.length,
          completedAt: now,
          parts: {
            createMany: {
              data: sortedParts.map((part) => ({
                partNumber: part.partNumber,
                etag: part.etag,
              })),
              skipDuplicates: true,
            },
          },
        },
        select: uploadSessionSelect,
      });

      await tx.video.update({
        where: {
          id: videoId,
        },
        data: {
          sourceObjectKey: session.objectKey,
        },
      });

      return updatedSession;
    });

    return toVideoUploadSessionResult(completedSession);
  },

  async abortMultipartUpload({
    uploadSessionId,
    userId,
    videoId,
  }: AbortVideoMultipartUploadInput): Promise<VideoUploadSessionResult> {
    const session = await findOwnedUploadSession(deps.prisma, {
      uploadSessionId,
      userId,
      videoId,
    });

    if (session.status === 'aborted') {
      return toVideoUploadSessionResult(session);
    }

    if (session.status === 'completed') {
      throw new InvalidVideoUploadSessionStateError();
    }

    await deps.objectStorage.abortMultipartUpload({
      objectKey: session.objectKey,
      uploadId: session.uploadId,
    });

    const now = deps.clock.now();
    const abortedSession = await runSerializableTransaction(deps, async (tx) => {
      const updatedSession = await tx.videoUploadSession.update({
        where: {
          id: session.id,
        },
        data: {
          status: 'aborted',
          abortedAt: now,
        },
        select: uploadSessionSelect,
      });
      const activeSession = await findActiveUploadSession(tx, now, videoId);
      const video = await findOwnedVideo(tx, userId, videoId);

      if (!activeSession && video.processingStatus === 'uploading') {
        await tx.video.update({
          where: {
            id: videoId,
          },
          data: {
            processingStatus: 'draft',
          },
        });
      }

      return updatedSession;
    });

    return toVideoUploadSessionResult(abortedSession);
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
});
