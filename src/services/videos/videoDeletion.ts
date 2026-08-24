import { Prisma } from '@prisma/client';
import {
  getSerializableTransactionRetryDelayMs,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import {
  requestExternalResourceAbsence,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
} from '../externalResources.js';
import type { VideoModerationStatus } from './types/ports.types.js';
import type { VideosDependencies } from './videos.dependencies.js';

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
