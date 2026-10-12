import { Prisma } from '@prisma/client';
import {
  getSerializableTransactionRetryDelayMs,
  isSerializableTransactionConflictError,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import {
  requestExternalResourceAbsence,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
} from '../../services/externalResources.js';
import type { VideoModerationStatus } from './types.js';
import { VideoDeletionTemporarilyUnavailableError } from './errors.js';
import { VideoNotFoundError } from './shared/errors.js';
import type { DeleteVideoInput, VideoLifecycleMaintenancePort } from './types.js';
import type { VideosDependencies } from './dependencies.js';

const VIDEO_HARD_DELETION_TRANSACTION_MAX_ATTEMPTS = 5;

export type LockedVideoForHardDeletion = {
  id: string;
  publicId: string;
  ownerId: string;
  moderationStatus: VideoModerationStatus;
  rejectedAt: Date | null;
  deletionRequestedAt: Date | null;
};

type HardDeleteVideoInput = {
  videoId: string;
  requestedAt: Date;
  isEligible: (video: LockedVideoForHardDeletion) => boolean;
};

type HardDeleteVideoResult = {
  deleted: boolean;
  targetsScheduled: number;
};

export const hardDeleteVideo = async (
  deps: Pick<VideosDependencies, 'prisma'>,
  { isEligible, requestedAt, videoId }: HardDeleteVideoInput,
): Promise<HardDeleteVideoResult> =>
  runSerializableTransaction(
    deps.prisma,
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "video_transcode_jobs"
          WHERE "video_id" = CAST(${videoId} AS UUID)
          ORDER BY "id"
          FOR UPDATE
        `,
      );
      const [video] = await tx.$queryRaw<LockedVideoForHardDeletion[]>(
        Prisma.sql`
          SELECT
            "id"::text AS "id",
            "public_id" AS "publicId",
            "owner_id"::text AS "ownerId",
            "moderation_status" AS "moderationStatus",
            "rejected_at" AS "rejectedAt",
            "deletion_requested_at" AS "deletionRequestedAt"
          FROM "videos"
          WHERE "id" = CAST(${videoId} AS UUID)
          FOR UPDATE
        `,
      );

      if (!video || !isEligible(video)) {
        return { deleted: false, targetsScheduled: 0 };
      }

      const targets = await tx.externalResourceTarget.findMany({
        where: {
          videoId,
          role: {
            in: [...VIDEO_EXTERNAL_RESOURCE_ROLES],
          },
          state: {
            not: 'confirmed_absent',
          },
        },
        select: {
          id: true,
        },
        orderBy: {
          id: 'asc',
        },
      });
      let targetsScheduled = 0;

      for (const target of targets) {
        if (await requestExternalResourceAbsence(tx, target.id, requestedAt)) {
          targetsScheduled += 1;
        }
      }

      await tx.video.delete({
        where: { id: video.id },
      });

      return { deleted: true, targetsScheduled };
    },
    {
      maxAttempts: VIDEO_HARD_DELETION_TRANSACTION_MAX_ATTEMPTS,
      retryDelayMs: getSerializableTransactionRetryDelayMs,
    },
  );

const VIDEO_PENDING_PURGE_MAINTENANCE_BATCH_SIZE = 100;

const deleteExpiredVideoPendingPurge = async (
  deps: VideosDependencies,
  videoId: string,
  observedAt: Date,
  purgeBefore: Date,
): Promise<{ deleted: boolean; targetsScheduled: number }> =>
  hardDeleteVideo(deps, {
    videoId,
    requestedAt: observedAt,
    isEligible: (video) =>
      (video.moderationStatus === 'rejected' &&
        video.rejectedAt !== null &&
        video.rejectedAt < purgeBefore) ||
      (video.deletionRequestedAt !== null && video.deletionRequestedAt < purgeBefore),
  });

const deleteExpiredVideosPendingPurge = async (
  deps: VideosDependencies,
  {
    observedAt,
    purgeBefore,
  }: {
    observedAt: Date;
    purgeBefore: Date;
  },
): Promise<{
  videosPendingPurgeDeleted: number;
  videoPendingPurgeTargetsScheduled: number;
}> => {
  const [rejectedCandidates, deletionCandidates] = await Promise.all([
    deps.prisma.video.findMany({
      where: {
        moderationStatus: 'rejected',
        rejectedAt: {
          lt: purgeBefore,
        },
      },
      select: {
        id: true,
        rejectedAt: true,
      },
      orderBy: [{ rejectedAt: 'asc' }, { id: 'asc' }],
      take: VIDEO_PENDING_PURGE_MAINTENANCE_BATCH_SIZE,
    }),
    deps.prisma.video.findMany({
      where: {
        deletionRequestedAt: {
          lt: purgeBefore,
        },
      },
      select: {
        id: true,
        deletionRequestedAt: true,
      },
      orderBy: [{ deletionRequestedAt: 'asc' }, { id: 'asc' }],
      take: VIDEO_PENDING_PURGE_MAINTENANCE_BATCH_SIZE,
    }),
  ]);
  const effectiveDeadlineByVideoId = new Map<string, Date>();

  for (const candidate of rejectedCandidates) {
    if (candidate.rejectedAt) {
      effectiveDeadlineByVideoId.set(candidate.id, candidate.rejectedAt);
    }
  }

  for (const candidate of deletionCandidates) {
    if (!candidate.deletionRequestedAt) {
      continue;
    }

    const currentDeadline = effectiveDeadlineByVideoId.get(candidate.id);

    if (!currentDeadline || candidate.deletionRequestedAt < currentDeadline) {
      effectiveDeadlineByVideoId.set(candidate.id, candidate.deletionRequestedAt);
    }
  }

  const candidates = [...effectiveDeadlineByVideoId.entries()]
    .map(([id, effectiveDeadline]) => ({ id, effectiveDeadline }))
    .sort((left, right) => {
      const deadlineComparison =
        left.effectiveDeadline.getTime() - right.effectiveDeadline.getTime();

      if (deadlineComparison !== 0) {
        return deadlineComparison;
      }

      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .slice(0, VIDEO_PENDING_PURGE_MAINTENANCE_BATCH_SIZE);
  let videosPendingPurgeDeleted = 0;
  let videoPendingPurgeTargetsScheduled = 0;

  for (const { id } of candidates) {
    const result = await deleteExpiredVideoPendingPurge(deps, id, observedAt, purgeBefore);

    if (result.deleted) {
      videosPendingPurgeDeleted += 1;
      videoPendingPurgeTargetsScheduled += result.targetsScheduled;
    }
  }

  return {
    videosPendingPurgeDeleted,
    videoPendingPurgeTargetsScheduled,
  };
};

export const deleteOwnedVideo = async (
  deps: VideosDependencies,
  { publicId, userId }: DeleteVideoInput,
): Promise<void> => {
  const candidate = await deps.prisma.video.findFirst({
    where: {
      publicId,
      ownerId: userId,
    },
    select: {
      id: true,
    },
  });

  if (!candidate) {
    throw new VideoNotFoundError();
  }

  const result = await hardDeleteVideo(deps, {
    videoId: candidate.id,
    requestedAt: deps.clock.now(),
    isEligible: (video) => video.publicId === publicId && video.ownerId === userId,
  }).catch((err: unknown) => {
    if (isSerializableTransactionConflictError(err)) {
      throw new VideoDeletionTemporarilyUnavailableError({ cause: err });
    }

    throw err;
  });

  if (!result.deleted) {
    throw new VideoNotFoundError();
  }
};

export const createVideoLifecycleService = (deps: VideosDependencies) =>
  ({
    async deleteExpiredVideosPendingPurge(input) {
      return deleteExpiredVideosPendingPurge(deps, input);
    },
  }) satisfies VideoLifecycleMaintenancePort;
