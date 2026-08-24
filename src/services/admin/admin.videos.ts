import { Prisma } from '@prisma/client';
import {
  VIDEO_DELETION_REASON_MAX_LENGTH,
  VIDEO_REJECTION_REASON_MAX_LENGTH,
} from '../../config/constants.js';
import {
  AdminVideoDeletionReasonInvalidError,
  AdminVideoRejectionReasonInvalidError,
  ADMIN_VIDEO_DELETION_REASON_NUL_MESSAGE,
  ADMIN_VIDEO_DELETION_REASON_REQUIRED_MESSAGE,
  ADMIN_VIDEO_DELETION_REASON_TOO_LONG_MESSAGE,
  ADMIN_VIDEO_REJECTION_REASON_NUL_MESSAGE,
  ADMIN_VIDEO_REJECTION_REASON_REQUIRED_MESSAGE,
  ADMIN_VIDEO_REJECTION_REASON_TOO_LONG_MESSAGE,
} from '../admin.errors.js';
import { handleExpectedMailerError } from '../mailer/mailer.helpers.js';
import { VideoNotFoundError } from '../videos.errors.js';
import { buildVideoSearchFilter } from '../videos/videoSearch.js';
import { resolveBestEffortLink, videoThumbnailPath } from '../assets/assetLinks.js';
import type { AdminDependencies } from './admin.dependencies.js';
import type {
  AdminVideoSummary,
  AdminVideosPort,
  ListAdminVideosInput,
  ListAdminVideosResult,
  ModerateAdminVideoInput,
  ModerateAdminVideoResult,
  RequestAdminVideoDeletionInput,
  RequestAdminVideoDeletionResult,
} from './types/videos.types.js';

const DEFAULT_ADMIN_VIDEOS_LIMIT = 20;
const MAX_ADMIN_VIDEOS_LIMIT = 100;

const adminVideoSelect = {
  id: true,
  publicId: true,
  ownerId: true,
  title: true,
  moderationStatus: true,
  processingStatus: true,
  visibility: true,
  createdAt: true,
  thumbnailObjectKey: true,
  publishedAt: true,
  rejectedAt: true,
  rejectionReason: true,
  deletionRequestedAt: true,
  deletionReason: true,
  deletionOrigin: true,
  owner: {
    select: {
      username: true,
    },
  },
} satisfies Prisma.VideoSelect;

type AdminVideoRecord = Prisma.VideoGetPayload<{ select: typeof adminVideoSelect }>;

type LockedAdminVideo = Pick<
  AdminVideoRecord,
  | 'moderationStatus'
  | 'publishedAt'
  | 'rejectedAt'
  | 'rejectionReason'
  | 'deletionRequestedAt'
  | 'deletionReason'
  | 'deletionOrigin'
  | 'title'
> & {
  ownerEmail: string;
};

const lockAdminVideo = async (
  tx: Prisma.TransactionClient,
  videoId: string,
): Promise<LockedAdminVideo> => {
  const [video] = await tx.$queryRaw<Array<LockedAdminVideo>>(
    Prisma.sql`
      SELECT
        v."moderation_status" AS "moderationStatus",
        v."published_at" AS "publishedAt",
        v."rejected_at" AS "rejectedAt",
        v."rejection_reason" AS "rejectionReason",
        v."deletion_requested_at" AS "deletionRequestedAt",
        v."deletion_reason" AS "deletionReason",
        v."deletion_origin" AS "deletionOrigin",
        v."title",
        u."email" AS "ownerEmail"
      FROM "videos" AS v
      INNER JOIN "users" AS u ON u."id" = v."owner_id"
      WHERE v."id" = CAST(${videoId} AS UUID)
      FOR UPDATE OF v
    `,
  );

  if (!video) {
    throw new VideoNotFoundError();
  }

  return video;
};

const normalizeVideoRejectionReason = (reason: string): string => {
  const normalizedReason = reason.trim();

  if (!normalizedReason) {
    throw new AdminVideoRejectionReasonInvalidError(ADMIN_VIDEO_REJECTION_REASON_REQUIRED_MESSAGE);
  }

  if (normalizedReason.length > VIDEO_REJECTION_REASON_MAX_LENGTH) {
    throw new AdminVideoRejectionReasonInvalidError(ADMIN_VIDEO_REJECTION_REASON_TOO_LONG_MESSAGE);
  }

  if (normalizedReason.includes('\u0000')) {
    throw new AdminVideoRejectionReasonInvalidError(ADMIN_VIDEO_REJECTION_REASON_NUL_MESSAGE);
  }

  return normalizedReason;
};

const normalizeVideoDeletionReason = (reason: string): string => {
  const normalizedReason = reason.trim();

  if (!normalizedReason) {
    throw new AdminVideoDeletionReasonInvalidError(ADMIN_VIDEO_DELETION_REASON_REQUIRED_MESSAGE);
  }

  if (normalizedReason.length > VIDEO_DELETION_REASON_MAX_LENGTH) {
    throw new AdminVideoDeletionReasonInvalidError(ADMIN_VIDEO_DELETION_REASON_TOO_LONG_MESSAGE);
  }

  if (normalizedReason.includes('\u0000')) {
    throw new AdminVideoDeletionReasonInvalidError(ADMIN_VIDEO_DELETION_REASON_NUL_MESSAGE);
  }

  return normalizedReason;
};

const normalizeAdminVideosLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_ADMIN_VIDEOS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ADMIN_VIDEOS_LIMIT);
};

const toAdminVideoSummary = ({
  owner,
  thumbnailObjectKey,
  ...video
}: AdminVideoRecord): AdminVideoSummary => ({
  ...video,
  username: owner.username,
  thumbnailPath: resolveBestEffortLink(thumbnailObjectKey, videoThumbnailPath(video.publicId)),
});

const listAdminVideos = async (
  deps: AdminDependencies,
  input: ListAdminVideosInput,
): Promise<ListAdminVideosResult> => {
  const { cursor, limit, moderationStatus, processingStatus, search, sort = 'newest' } = input;
  const pageSize = normalizeAdminVideosLimit(limit);
  const direction = sort === 'oldest' ? 'asc' : 'desc';
  const cursorOperator = sort === 'oldest' ? 'gt' : 'lt';
  const statusFilter = {
    ...(moderationStatus === undefined ? {} : { moderationStatus }),
    ...(processingStatus === undefined ? {} : { processingStatus }),
  } satisfies Prisma.VideoWhereInput;
  const searchFilter = buildVideoSearchFilter(search);
  const hasStatusFilter = moderationStatus !== undefined || processingStatus !== undefined;
  const resultFilter = searchFilter
    ? hasStatusFilter
      ? { AND: [statusFilter, searchFilter] }
      : searchFilter
    : statusFilter;
  const cursorFilter: Prisma.VideoWhereInput = cursor
    ? {
        OR: [
          { createdAt: { [cursorOperator]: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { [cursorOperator]: cursor.id } },
        ],
      }
    : {};
  const pageFilter = cursor ? { AND: [resultFilter, cursorFilter] } : resultFilter;

  const [queriedVideos, total] = await deps.prisma.$transaction([
    deps.prisma.video.findMany({
      where: pageFilter,
      select: adminVideoSelect,
      orderBy: [{ createdAt: direction }, { id: direction }],
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
    videos: videos.map(toAdminVideoSummary),
    total,
    nextCursor,
  };
};

const moderateAdminVideo = async (
  deps: AdminDependencies,
  input: ModerateAdminVideoInput,
): Promise<ModerateAdminVideoResult> => {
  const { decision, videoId } = input;
  const normalizedReason =
    decision === 'rejected' ? normalizeVideoRejectionReason(input.reason) : null;
  const now = deps.clock.now();
  const { rejectionNotification, video } = await deps.prisma.$transaction(async (tx) => {
    const currentVideo = await lockAdminVideo(tx, videoId);

    const isNewRejection = decision === 'rejected' && currentVideo.moderationStatus !== 'rejected';
    const updatedVideo = await tx.video.update({
      where: { id: videoId },
      data:
        decision === 'approved'
          ? {
              moderationStatus: 'approved',
              visibility: currentVideo.deletionRequestedAt === null ? 'public' : 'unlisted',
              publishedAt: currentVideo.publishedAt ?? now,
              rejectedAt: null,
              rejectionReason: null,
            }
          : {
              moderationStatus: 'rejected',
              visibility: 'unlisted',
              rejectedAt: isNewRejection ? now : currentVideo.rejectedAt,
              rejectionReason: isNewRejection ? normalizedReason : currentVideo.rejectionReason,
            },
      select: adminVideoSelect,
    });

    return {
      video: updatedVideo,
      rejectionNotification:
        isNewRejection && normalizedReason
          ? {
              email: currentVideo.ownerEmail,
              reason: normalizedReason,
              title: currentVideo.title,
            }
          : null,
    };
  });

  if (rejectionNotification) {
    try {
      await deps.mailer.sendVideoRejectedEmail(
        rejectionNotification.email,
        rejectionNotification.title,
        rejectionNotification.reason,
      );
    } catch (err) {
      await handleExpectedMailerError({
        err,
        logger: deps.logger,
        warningMessage: `Video rejection notification email could not be sent for video ${video.id}`,
      });
    }
  }

  return {
    video: toAdminVideoSummary(video),
  };
};

const requestAdminVideoDeletion = async (
  deps: AdminDependencies,
  { actorRole, reason, videoId }: RequestAdminVideoDeletionInput,
): Promise<RequestAdminVideoDeletionResult> => {
  const normalizedReason = normalizeVideoDeletionReason(reason);
  const now = deps.clock.now();
  const { deletionNotification, video } = await deps.prisma.$transaction(async (tx) => {
    const currentVideo = await lockAdminVideo(tx, videoId);

    const isNewDeletionRequest = currentVideo.deletionRequestedAt === null;
    const updatedVideo = await tx.video.update({
      where: { id: videoId },
      data: {
        visibility: 'unlisted',
        deletionRequestedAt: isNewDeletionRequest ? now : currentVideo.deletionRequestedAt,
        deletionReason: isNewDeletionRequest ? normalizedReason : currentVideo.deletionReason,
        deletionOrigin: isNewDeletionRequest ? actorRole : currentVideo.deletionOrigin,
      },
      select: adminVideoSelect,
    });

    return {
      video: updatedVideo,
      deletionNotification: isNewDeletionRequest
        ? {
            email: currentVideo.ownerEmail,
            reason: normalizedReason,
            title: currentVideo.title,
          }
        : null,
    };
  });

  if (deletionNotification) {
    try {
      await deps.mailer.sendVideoDeletionScheduledEmail(
        deletionNotification.email,
        deletionNotification.title,
        deletionNotification.reason,
      );
    } catch (err) {
      await handleExpectedMailerError({
        err,
        logger: deps.logger,
        warningMessage: `Video deletion notification email could not be sent for video ${video.id}`,
      });
    }
  }

  return {
    video: toAdminVideoSummary(video),
  };
};

export const createAdminVideosService = (deps: AdminDependencies): AdminVideosPort => ({
  listVideos: (input) => listAdminVideos(deps, input),
  moderateVideo: (input) => moderateAdminVideo(deps, input),
  requestVideoDeletion: (input) => requestAdminVideoDeletion(deps, input),
});
