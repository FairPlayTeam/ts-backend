import type { Prisma } from '@prisma/client';
import {
  VIDEO_SOURCE_THUMBNAIL_HEIGHT_PX,
  VIDEO_SOURCE_THUMBNAIL_WIDTH_PX,
} from '../../config/constants.js';
import type { VideoUploadsDependencies } from './dependencies.js';
import {
  ExternalResourceNotDesiredError,
  requestExternalResourceAbsence,
  type ExternalResourceReconciliationHandlers,
  type ExternalResourceReconciliationHandler,
} from '../../services/externalResources.js';
import { VideoNotFoundError } from '../../services/videos.errors.js';
import { InvalidVideoUploadSessionStateError, VideoUploadSessionNotFoundError } from './errors.js';
import {
  ACTIVE_UPLOAD_SESSION_STATUSES,
  SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES,
  VIDEO_SOURCE_THUMBNAIL_CONTENT_TYPE,
} from './types.js';
import {
  completedSourceSessionSelect,
  reconciliationUploadSessionSelect,
  type ReconciliationUploadSessionRecord,
} from './repository.js';
type TransactionClient = Prisma.TransactionClient;
export const findActiveUploadSession = (
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

export const resetVideoWithoutSourceAfterUploadEnds = async (
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

const publishCompletedSourceInTransaction = async (
  tx: TransactionClient,
  session: Pick<
    ReconciliationUploadSessionRecord,
    'externalResourceTargetId' | 'id' | 'objectKey' | 'userId' | 'videoId'
  >,
  sizeBytes: number,
  now: Date,
): Promise<void> => {
  const currentSession = await tx.videoUploadSession.findFirst({
    where: {
      id: session.id,
      userId: session.userId,
      videoId: session.videoId,
    },
    select: completedSourceSessionSelect,
  });

  if (!currentSession) {
    throw new VideoUploadSessionNotFoundError();
  }

  if (currentSession.status === 'completed') {
    return;
  }

  if (currentSession.status !== 'completing') {
    throw new InvalidVideoUploadSessionStateError();
  }

  const sourceThumbnail = currentSession.sourceThumbnail;

  if (
    sourceThumbnail &&
    (sourceThumbnail.bucket !== sourceThumbnail.externalResourceTarget.bucket ||
      sourceThumbnail.objectKey !== sourceThumbnail.externalResourceTarget.selector ||
      sourceThumbnail.mimeType !== VIDEO_SOURCE_THUMBNAIL_CONTENT_TYPE ||
      sourceThumbnail.width !== VIDEO_SOURCE_THUMBNAIL_WIDTH_PX ||
      sourceThumbnail.height !== VIDEO_SOURCE_THUMBNAIL_HEIGHT_PX ||
      sourceThumbnail.externalResourceTarget.userId !== currentSession.userId ||
      sourceThumbnail.externalResourceTarget.videoId !== currentSession.videoId ||
      sourceThumbnail.externalResourceTarget.generation !== currentSession.id ||
      sourceThumbnail.externalResourceTarget.role !== 'source_thumbnail' ||
      sourceThumbnail.externalResourceTarget.goal !== 'present' ||
      sourceThumbnail.externalResourceTarget.state !== 'confirmed_present' ||
      sourceThumbnail.externalResourceTarget.selectorKind !== 'exact' ||
      sourceThumbnail.externalResourceTarget.expectedSizeBytes !==
        BigInt(sourceThumbnail.sizeBytes))
  ) {
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
          sourceThumbnail: {
            select: {
              externalResourceTargetId: true,
            },
          },
        },
      },
    },
  });

  if (!video) {
    throw new VideoNotFoundError();
  }

  const previousTargetId = video.sourceUploadSession?.externalResourceTargetId ?? null;
  const previousThumbnailTargetId =
    video.sourceUploadSession?.sourceThumbnail?.externalResourceTargetId ?? null;

  await tx.videoUploadSession.update({
    where: {
      id: session.id,
    },
    data: {
      status: 'completed',
      partCount: currentSession._count.parts,
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
    if (previousThumbnailTargetId) {
      await requestExternalResourceAbsence(tx, previousThumbnailTargetId, now);
    }
  }
};

export const createVideoReconciliationHandler = (
  deps: VideoUploadsDependencies,
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

export const createVideoSourceThumbnailReconciliationHandler = (
  deps: VideoUploadsDependencies,
): ExternalResourceReconciliationHandler => ({
  async preparePresent(target) {
    if (!target.videoId) {
      throw new ExternalResourceNotDesiredError(
        'Video source thumbnail reservation has no video scope',
      );
    }

    const session = await deps.prisma.videoUploadSession.findFirst({
      where: {
        id: target.generation,
        userId: target.userId,
        videoId: target.videoId,
        status: {
          in: [...SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES],
        },
        expiresAt: {
          gt: deps.clock.now(),
        },
      },
      select: {
        id: true,
      },
    });

    if (!session) {
      throw new ExternalResourceNotDesiredError(
        'Video source thumbnail upload session no longer accepts thumbnails',
      );
    }
  },

  async finalize(tx, target, verifiedObject) {
    if (target.goal === 'absent') {
      await tx.videoSourceThumbnail.deleteMany({
        where: {
          externalResourceTargetId: target.id,
        },
      });
      return;
    }

    if (!target.videoId || !verifiedObject) {
      throw new ExternalResourceNotDesiredError(
        'Video source thumbnail reservation cannot be published',
      );
    }

    const session = await tx.videoUploadSession.findFirst({
      where: {
        id: target.generation,
        userId: target.userId,
        videoId: target.videoId,
        status: {
          in: [...SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES],
        },
        expiresAt: {
          gt: deps.clock.now(),
        },
      },
      select: {
        id: true,
      },
    });

    if (!session) {
      throw new ExternalResourceNotDesiredError(
        'Video source thumbnail arrived after the upload session closed',
      );
    }

    const previousThumbnail = await tx.videoSourceThumbnail.findUnique({
      where: {
        uploadSessionId: session.id,
      },
      select: {
        externalResourceTargetId: true,
      },
    });

    await tx.videoSourceThumbnail.upsert({
      where: {
        uploadSessionId: session.id,
      },
      update: {
        externalResourceTargetId: target.id,
        bucket: target.bucket,
        objectKey: target.selector,
        mimeType: VIDEO_SOURCE_THUMBNAIL_CONTENT_TYPE,
        sizeBytes: verifiedObject.sizeBytes,
        width: VIDEO_SOURCE_THUMBNAIL_WIDTH_PX,
        height: VIDEO_SOURCE_THUMBNAIL_HEIGHT_PX,
      },
      create: {
        uploadSessionId: session.id,
        externalResourceTargetId: target.id,
        bucket: target.bucket,
        objectKey: target.selector,
        mimeType: VIDEO_SOURCE_THUMBNAIL_CONTENT_TYPE,
        sizeBytes: verifiedObject.sizeBytes,
        width: VIDEO_SOURCE_THUMBNAIL_WIDTH_PX,
        height: VIDEO_SOURCE_THUMBNAIL_HEIGHT_PX,
      },
    });

    if (previousThumbnail && previousThumbnail.externalResourceTargetId !== target.id) {
      await requestExternalResourceAbsence(
        tx,
        previousThumbnail.externalResourceTargetId,
        deps.clock.now(),
      );
    }
  },
});

export const createVideoUploadsReconciliationHandlers = (
  deps: VideoUploadsDependencies,
): Required<Pick<ExternalResourceReconciliationHandlers, 'source' | 'source_thumbnail'>> => ({
  source: createVideoReconciliationHandler(deps),
  source_thumbnail: createVideoSourceThumbnailReconciliationHandler(deps),
});
