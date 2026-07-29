import { Prisma } from '@prisma/client';
import { VideoNotFoundError } from '../videos.errors.js';
import type { AdminDependencies } from './admin.dependencies.js';
import type {
  AdminVideoSummary,
  AdminVideosPort,
  ListAdminVideosInput,
  ListAdminVideosResult,
  ModerateAdminVideoInput,
  ModerateAdminVideoResult,
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
  owner: {
    select: {
      username: true,
    },
  },
} satisfies Prisma.VideoSelect;

type AdminVideoRecord = Prisma.VideoGetPayload<{ select: typeof adminVideoSelect }>;

const normalizeAdminVideosLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_ADMIN_VIDEOS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ADMIN_VIDEOS_LIMIT);
};

const toAdminVideoSummary = ({ owner, ...video }: AdminVideoRecord): AdminVideoSummary => ({
  ...video,
  username: owner.username,
});

const listAdminVideos = async (
  deps: AdminDependencies,
  input: ListAdminVideosInput,
): Promise<ListAdminVideosResult> => {
  const { cursor, limit, moderationStatus, processingStatus, sort = 'newest' } = input;
  const pageSize = normalizeAdminVideosLimit(limit);
  const direction = sort === 'oldest' ? 'asc' : 'desc';
  const cursorOperator = sort === 'oldest' ? 'gt' : 'lt';
  const resultFilter = {
    ...(moderationStatus === undefined ? {} : { moderationStatus }),
    ...(processingStatus === undefined ? {} : { processingStatus }),
  } satisfies Prisma.VideoWhereInput;
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
  { decision, videoId }: ModerateAdminVideoInput,
): Promise<ModerateAdminVideoResult> => {
  const now = deps.clock.now();
  const video = await deps.prisma.$transaction(async (tx) => {
    const [currentVideo] = await tx.$queryRaw<
      Array<Pick<AdminVideoRecord, 'moderationStatus' | 'publishedAt' | 'rejectedAt'>>
    >(
      Prisma.sql`
        SELECT
          "moderation_status" AS "moderationStatus",
          "published_at" AS "publishedAt",
          "rejected_at" AS "rejectedAt"
        FROM "videos"
        WHERE "id" = CAST(${videoId} AS UUID)
        FOR UPDATE
      `,
    );

    if (!currentVideo) {
      throw new VideoNotFoundError();
    }

    return tx.video.update({
      where: { id: videoId },
      data:
        decision === 'approved'
          ? {
              moderationStatus: 'approved',
              visibility: 'public',
              publishedAt: currentVideo.publishedAt ?? now,
              rejectedAt: null,
            }
          : {
              moderationStatus: 'rejected',
              visibility: 'unlisted',
              rejectedAt:
                currentVideo.moderationStatus === 'rejected' ? currentVideo.rejectedAt : now,
            },
      select: adminVideoSelect,
    });
  });

  return {
    video: toAdminVideoSummary(video),
  };
};

export const createAdminVideosService = (deps: AdminDependencies): AdminVideosPort => ({
  listVideos: (input) => listAdminVideos(deps, input),
  moderateVideo: (input) => moderateAdminVideo(deps, input),
});
