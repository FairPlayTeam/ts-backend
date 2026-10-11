import { Prisma } from '@prisma/client';
import { constraintContains, isPrismaUniqueError } from '../../lib/prismaErrors.js';
import {
  getSerializableTransactionRetryDelayMs,
  isSerializableTransactionConflictError,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import {
  buildVideoArtifactManifest,
  videoHlsSegmentObjectKey,
  type VideoObjectKeyQuality,
} from './videoObjectKeys.js';
import {
  isVideoHlsGenerationToken,
  parseVideoHlsQuality,
  parseVideoHlsSegmentName,
  rewriteVideoHlsMasterPlaylist,
  rewriteVideoHlsRenditionPlaylist,
  toVideoObjectKeyQuality,
  toVideoRenditionQuality,
  VIDEO_HLS_PLAYLIST_MAX_BYTES,
} from './videoHls.js';
import { VIDEO_PUBLIC_ID_PATTERN } from './videoPublicId.js';
import type { VideosDependencies } from './videos.dependencies.js';
import { isPrismaForeignKeyConstraintError } from '../auth/auth.prismaErrors.js';
import {
  PublicProfileNotFoundError,
  PUBLIC_PROFILE_VISIBILITY_SCOPE,
} from '../../modules/profiles/index.js';
import {
  VideoDeletionTemporarilyUnavailableError,
  VideoNotFoundError,
  VideoRatingTemporarilyUnavailableError,
  VideoSelfRatingForbiddenError,
} from '../videos.errors.js';
import type {
  CreateVideoInput,
  CreateVideoResult,
  DeleteVideoInput,
  GetMyVideoRatingInput,
  GetPublicVideoDetailInput,
  GetPublicVideoDetailResult,
  GetVideoRatingInput,
  GetVideoHlsMasterInput,
  GetVideoHlsRenditionInput,
  GetVideoHlsSegmentInput,
  GetVideoThumbnailInput,
  ListPublicProfileVideosInput,
  ListPublicVideosInput,
  ListPublicVideosResult,
  ListMyVideosInput,
  ListMyVideosResult,
  PublicVideoCursor,
  PublicVideoSearchSort,
  RateVideoInput,
  SearchPublicVideosInput,
  SearchPublicVideosResult,
  VideoHlsPlaylistResult,
  VideoHlsSegmentResult,
  VideoRatingAggregateResult,
  VideoRatingResult,
  VideoThumbnailResult,
  VideosService,
} from './types/ports.types.js';
import { calculateVideoRatingAverage } from './videoRating.js';
import { recordVideoView, toUtcVideoViewDay } from './videoViews.js';
import { publicVideoCatalogWhere } from './videoReadability.js';
import {
  createPublicCreatorSearchTransactionRunner,
  searchPublicCreators,
} from './publicCreatorSearch.js';
import { searchPublicVideoCatalog } from './publicVideoSearch.js';
import {
  readForProxy,
  resolveBestEffortLink,
  resolveSignedRedirect,
  videoHlsMasterPath,
  videoThumbnailPath,
} from '../assets/assetLinks.js';
import {
  isVideoWritableEngagement,
  readableVideoWhere,
  WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL,
} from './videoReadability.js';
import {
  profileAvatarMediaAssetsSelection,
  toProfileMediaUrl,
} from '../userMedia/userMedia.profileAssets.js';
import { hardDeleteVideo } from './videoDeletion.js';

const VIDEO_RATING_TRANSACTION_MAX_ATTEMPTS = 10;
const DEFAULT_MY_VIDEOS_LIMIT = 20;
const MAX_MY_VIDEOS_LIMIT = 100;
const DEFAULT_PUBLIC_VIDEO_LIST_LIMIT = 20;
const MAX_PUBLIC_VIDEO_LIST_LIMIT = 100;
const PUBLIC_ID_MAX_CREATE_ATTEMPTS = 5;
const VIDEO_PENDING_PURGE_MAINTENANCE_BATCH_SIZE = 100;

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
  thumbnailObjectKey: true,
  ratingSum: true,
  ratingCount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VideoSelect;

const myVideoSelect = {
  ...videoSelect,
  deletionRequestedAt: true,
} satisfies Prisma.VideoSelect;

const publicVideoCatalogSelect = {
  publicId: true,
  title: true,
  description: true,
  tags: true,
  thumbnailObjectKey: true,
  ratingSum: true,
  ratingCount: true,
  viewCount: true,
  durationSeconds: true,
  publishedAt: true,
  createdAt: true,
  owner: {
    select: {
      username: true,
      displayName: true,
    },
  },
} satisfies Prisma.VideoSelect;

const publicVideoDetailSelect = {
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
  deletionRequestedAt: true,
  ratingSum: true,
  ratingCount: true,
  thumbnailObjectKey: true,
  viewCount: true,
  commentCount: true,
  durationSeconds: true,
  publishedAt: true,
  createdAt: true,
  owner: {
    select: {
      username: true,
      displayName: true,
      mediaAssets: profileAvatarMediaAssetsSelection,
    },
  },
  activeArtifactGeneration: {
    select: {
      id: true,
    },
  },
} satisfies Prisma.VideoSelect;

type PublicVideoCatalogRecord = Prisma.VideoGetPayload<{
  select: typeof publicVideoCatalogSelect;
}>;

type PublicVideoDetailRecord = Prisma.VideoGetPayload<{
  select: typeof publicVideoDetailSelect;
}>;

type VideoMetadataRecord = Prisma.VideoGetPayload<{
  select: typeof videoSelect;
}>;

type MyVideoMetadataRecord = Prisma.VideoGetPayload<{
  select: typeof myVideoSelect;
}>;

type TransactionClient = Prisma.TransactionClient;

const isPublicIdUniqueConstraintError = (err: unknown): boolean =>
  isPrismaUniqueError(err) &&
  constraintContains(
    err.meta,
    (candidate) =>
      candidate === 'publicId' || candidate === 'public_id' || candidate.includes('public_id'),
  );

const toVideoMetadata = ({
  ratingSum,
  thumbnailObjectKey,
  ...video
}: VideoMetadataRecord): CreateVideoResult['video'] => ({
  ...video,
  thumbnailPath: resolveBestEffortLink(thumbnailObjectKey, videoThumbnailPath(video.publicId)),
  ratingAverage: calculateVideoRatingAverage(ratingSum, video.ratingCount),
});

const toCreateVideoResult = (video: VideoMetadataRecord): CreateVideoResult => ({
  video: toVideoMetadata(video),
});

const toMyVideoMetadata = ({
  deletionRequestedAt,
  ...video
}: MyVideoMetadataRecord): ListMyVideosResult['videos'][number] => ({
  ...toVideoMetadata(video),
  deletionRequestedAt,
});

const normalizeMyVideosLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_MY_VIDEOS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_MY_VIDEOS_LIMIT);
};

const normalizePublicVideoListLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PUBLIC_VIDEO_LIST_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PUBLIC_VIDEO_LIST_LIMIT);
};

const toPublicVideoSearchSummary = ({
  createdAt,
  description,
  owner,
  publicId,
  publishedAt,
  ratingCount,
  ratingSum,
  tags,
  thumbnailObjectKey,
  title,
}: PublicVideoCatalogRecord): SearchPublicVideosResult['videos'][number] => ({
  publicId,
  title,
  description,
  tags,
  username: owner.username,
  thumbnailPath: resolveBestEffortLink(thumbnailObjectKey, videoThumbnailPath(publicId)),
  ratingAverage: calculateVideoRatingAverage(ratingSum, ratingCount),
  ratingCount,
  publishedAt,
  createdAt,
});

const requireReadyVideoDuration = (durationSeconds: number | null): number => {
  if (durationSeconds === null) {
    throw new Error('Ready video is missing persisted duration');
  }

  return durationSeconds;
};

const toPublicVideoFeedCard = ({
  createdAt,
  durationSeconds,
  owner,
  publicId,
  thumbnailObjectKey,
  title,
  viewCount,
}: PublicVideoCatalogRecord): ListPublicVideosResult['videos'][number] => ({
  publicId,
  title,
  createdAt,
  thumbnailPath: resolveBestEffortLink(thumbnailObjectKey, videoThumbnailPath(publicId)),
  creator: {
    username: owner.username,
    displayName: owner.displayName,
  },
  viewCount,
  duration: requireReadyVideoDuration(durationSeconds),
});

type PublicVideoCatalogPageInput = {
  beforeCatalogRead?: (tx: Prisma.TransactionClient) => Promise<void>;
  cursor?: PublicVideoCursor;
  filter?: Prisma.VideoWhereInput;
  limit?: number;
  sort?: PublicVideoSearchSort;
};

type PublicVideoCatalogPage = {
  videos: PublicVideoCatalogRecord[];
  total: number;
  nextCursor: PublicVideoCursor | null;
};

const toPublicVideoFeedResult = ({
  nextCursor,
  total,
  videos,
}: PublicVideoCatalogPage): ListPublicVideosResult => ({
  videos: videos.map(toPublicVideoFeedCard),
  total,
  nextCursor,
});

const queryPublicVideoCatalogPage = async (
  prisma: VideosDependencies['prisma'],
  { beforeCatalogRead, cursor, filter, limit, sort = 'newest' }: PublicVideoCatalogPageInput,
): Promise<PublicVideoCatalogPage> => {
  const pageSize = normalizePublicVideoListLimit(limit);
  const direction = sort === 'oldest' ? 'asc' : 'desc';
  const cursorOperator = sort === 'oldest' ? 'gt' : 'lt';
  const resultFilter = filter
    ? ({ AND: [publicVideoCatalogWhere, filter] } satisfies Prisma.VideoWhereInput)
    : publicVideoCatalogWhere;
  const cursorFilter: Prisma.VideoWhereInput = cursor
    ? {
        OR: [
          { createdAt: { [cursorOperator]: cursor.createdAt } },
          {
            createdAt: cursor.createdAt,
            publicId: { [cursorOperator]: cursor.publicId },
          },
        ],
      }
    : {};
  const pageFilter = cursor ? { AND: [resultFilter, cursorFilter] } : resultFilter;

  const [queriedVideos, total] = await prisma.$transaction(
    async (tx) => {
      if (beforeCatalogRead) {
        await beforeCatalogRead(tx);
      }

      const queriedVideos = await tx.video.findMany({
        where: pageFilter,
        select: publicVideoCatalogSelect,
        orderBy: [{ createdAt: direction }, { publicId: direction }],
        take: pageSize + 1,
      });
      const total = await tx.video.count({
        where: resultFilter,
      });

      return [queriedVideos, total] as const;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
  const videos = queriedVideos.slice(0, pageSize);
  const lastVideo = videos.at(-1);
  const nextCursor =
    queriedVideos.length > pageSize && lastVideo
      ? { createdAt: lastVideo.createdAt, publicId: lastVideo.publicId }
      : null;

  return { videos, total, nextCursor };
};

const toPublicVideoDetail = (
  video: PublicVideoDetailRecord,
  userRating: number | null,
): GetPublicVideoDetailResult['video'] => ({
  publicId: video.publicId,
  title: video.title,
  description: video.description,
  tags: video.tags,
  license: video.license,
  visibility: video.visibility,
  commentsOpen: video.allowComments && isVideoWritableEngagement(video),
  createdAt: video.createdAt,
  publishedAt: video.publishedAt,
  thumbnailPath: resolveBestEffortLink(
    video.thumbnailObjectKey,
    videoThumbnailPath(video.publicId),
  ),
  creator: {
    username: video.owner.username,
    displayName: video.owner.displayName,
    avatarUrl: toProfileMediaUrl(video.owner.username, 'avatar', video.owner.mediaAssets[0]),
  },
  ...toVideoRatingResult(video.ratingSum, video.ratingCount, userRating),
  viewCount: video.viewCount,
  commentCount: video.commentCount,
  duration: requireReadyVideoDuration(video.durationSeconds),
  hlsMasterPath: videoHlsMasterPath(video.publicId),
});

type LockedRatableVideo = {
  id: string;
  ownerId: string;
  ratingSum: number;
  ratingCount: number;
};

const lockRatableVideo = async (
  tx: TransactionClient,
  publicId: string,
): Promise<LockedRatableVideo> => {
  const [video] = await tx.$queryRaw<LockedRatableVideo[]>(
    Prisma.sql`
      SELECT
        v."id"::text AS "id",
        v."owner_id"::text AS "ownerId",
        v."rating_sum" AS "ratingSum",
        v."rating_count" AS "ratingCount"
      FROM "videos" AS v
      WHERE v."public_id" = ${publicId}
        AND ${WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL}
      FOR UPDATE
    `,
  );

  if (!video) {
    throw new VideoNotFoundError();
  }

  return video;
};

const toVideoRatingAggregateResult = (
  ratingSum: number,
  ratingCount: number,
): VideoRatingAggregateResult => ({
  ratingAverage: calculateVideoRatingAverage(ratingSum, ratingCount),
  ratingCount,
});

const toVideoRatingResult = (
  ratingSum: number,
  ratingCount: number,
  userRating: number | null,
): VideoRatingResult => ({
  ...toVideoRatingAggregateResult(ratingSum, ratingCount),
  userRating,
});

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

const deleteOwnedVideo = async (
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

const normalizeOptionalDescription = (description: string | null | undefined): string | null => {
  const normalizedDescription = description?.trim();

  return normalizedDescription ? normalizedDescription : null;
};

const assertValidPublicHlsVideoId = (publicId: string): void => {
  if (!VIDEO_PUBLIC_ID_PATTERN.test(publicId)) {
    throw new VideoNotFoundError();
  }
};

const findPublicHlsRendition = async (
  deps: VideosDependencies,
  {
    generationToken,
    publicId,
    quality,
  }: {
    generationToken: string;
    publicId: string;
    quality: VideoObjectKeyQuality;
  },
) => {
  assertValidPublicHlsVideoId(publicId);

  if (!isVideoHlsGenerationToken(generationToken)) {
    throw new VideoNotFoundError();
  }

  const persistedQuality = toVideoRenditionQuality(quality);
  const generation = await deps.prisma.videoArtifactGeneration.findFirst({
    where: {
      publicToken: generationToken,
      state: {
        in: ['active', 'retiring'],
      },
      video: {
        is: {
          publicId,
          ...readableVideoWhere,
        },
      },
      renditions: {
        some: {
          quality: persistedQuality,
        },
      },
    },
    select: {
      publicToken: true,
      bucket: true,
      renditions: {
        where: {
          quality: persistedQuality,
        },
        select: {
          quality: true,
          width: true,
          height: true,
          bitrate: true,
        },
        take: 1,
      },
    },
  });
  const persistedRendition = generation?.renditions[0];

  if (!generation || !persistedRendition) {
    throw new VideoNotFoundError();
  }

  const manifest = buildVideoArtifactManifest(generation.publicToken, [
    {
      quality: toVideoObjectKeyQuality(persistedRendition.quality),
      width: persistedRendition.width,
      height: persistedRendition.height,
      videoBitrate: persistedRendition.bitrate,
    },
  ]);
  const rendition = manifest.renditions[0];

  if (!rendition) {
    throw new VideoNotFoundError();
  }

  return {
    bucket: generation.bucket,
    rendition,
  };
};

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

  async deleteVideo(input: DeleteVideoInput): Promise<void> {
    return deleteOwnedVideo(deps, input);
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
        select: myVideoSelect,
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
      videos: videos.map(toMyVideoMetadata),
      total,
      nextCursor,
    };
  },

  async listPublicVideos({
    cursor,
    limit,
  }: ListPublicVideosInput): Promise<ListPublicVideosResult> {
    const page = await queryPublicVideoCatalogPage(deps.prisma, {
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    });

    return toPublicVideoFeedResult(page);
  },

  async listPublicProfileVideos({
    cursor,
    limit,
    ownerId,
  }: ListPublicProfileVideosInput): Promise<ListPublicVideosResult> {
    const page = await queryPublicVideoCatalogPage(deps.prisma, {
      beforeCatalogRead: async (tx) => {
        const visibleOwner = await tx.user.findFirst({
          where: {
            id: ownerId,
            ...PUBLIC_PROFILE_VISIBILITY_SCOPE,
          },
          select: { id: true },
        });

        if (!visibleOwner) {
          throw new PublicProfileNotFoundError();
        }
      },
      filter: { ownerId },
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    });

    return toPublicVideoFeedResult(page);
  },

  async searchPublicVideos(input: SearchPublicVideosInput): Promise<SearchPublicVideosResult> {
    return searchPublicVideoCatalog(
      {
        queryVideoPage: async (input) => {
          const page = await queryPublicVideoCatalogPage(deps.prisma, input);

          return {
            videos: page.videos.map(toPublicVideoSearchSummary),
            total: page.total,
            nextCursor: page.nextCursor,
          };
        },
        searchCreators: (searchTerm) =>
          searchPublicCreators(createPublicCreatorSearchTransactionRunner(deps.prisma), searchTerm),
      },
      input,
    );
  },

  async getPublicVideoDetail({
    publicId,
    userId,
  }: GetPublicVideoDetailInput): Promise<GetPublicVideoDetailResult> {
    assertValidPublicHlsVideoId(publicId);

    const detail = await deps.prisma.$transaction(
      async (tx) => {
        const video = await tx.video.findFirst({
          where: {
            publicId,
            ...readableVideoWhere,
            activeArtifactGeneration: {
              is: {
                state: 'active',
                renditions: {
                  some: {},
                },
              },
            },
          },
          select: publicVideoDetailSelect,
        });

        if (!video || !video.activeArtifactGeneration) {
          throw new VideoNotFoundError();
        }

        const rating = userId
          ? await tx.videoRating.findFirst({
              where: {
                userId,
                video: {
                  publicId,
                },
              },
              select: {
                value: true,
              },
            })
          : null;

        return {
          video: toPublicVideoDetail(video, rating?.value ?? null),
          videoId: video.id,
          ownerId: video.ownerId,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );

    // Keep playback availability and latency independent from analytics persistence.
    // The returned count belongs to the read snapshot; this request may appear on a later read.
    if (userId && userId !== detail.ownerId) {
      const viewedOn = toUtcVideoViewDay(deps.clock.now());

      void recordVideoView(deps.prisma, {
        userId,
        videoId: detail.videoId,
        viewedOn,
      }).catch((error: unknown) => {
        deps.logger.warn(
          { err: error, userId, videoId: detail.videoId, viewedOn },
          'Best-effort video view recording failed',
        );
      });
    }

    return { video: detail.video };
  },

  async getVideoRating({ publicId }: GetVideoRatingInput): Promise<VideoRatingAggregateResult> {
    const video = await deps.prisma.video.findFirst({
      where: {
        publicId,
        ...readableVideoWhere,
      },
      select: {
        ratingSum: true,
        ratingCount: true,
      },
    });

    if (!video) {
      throw new VideoNotFoundError();
    }

    return toVideoRatingAggregateResult(video.ratingSum, video.ratingCount);
  },

  async getMyVideoRating({ publicId, userId }: GetMyVideoRatingInput): Promise<VideoRatingResult> {
    return deps.prisma.$transaction(
      async (tx) => {
        const video = await tx.video.findFirst({
          where: {
            publicId,
            ...readableVideoWhere,
          },
          select: {
            id: true,
            ratingSum: true,
            ratingCount: true,
          },
        });

        if (!video) {
          throw new VideoNotFoundError();
        }

        const rating = await tx.videoRating.findUnique({
          where: {
            userId_videoId: {
              userId,
              videoId: video.id,
            },
          },
          select: {
            value: true,
          },
        });

        return toVideoRatingResult(video.ratingSum, video.ratingCount, rating?.value ?? null);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
  },

  async rateVideo({ publicId, userId, value }: RateVideoInput): Promise<VideoRatingResult> {
    try {
      return await runSerializableTransaction(
        deps.prisma,
        async (tx) => {
          const video = await lockRatableVideo(tx, publicId);
          const videoId = video.id;

          if (video.ownerId === userId) {
            throw new VideoSelfRatingForbiddenError();
          }

          const currentRating = await tx.videoRating.findUnique({
            where: {
              userId_videoId: {
                userId,
                videoId,
              },
            },
            select: {
              value: true,
            },
          });

          if (!currentRating) {
            await tx.videoRating.create({
              data: {
                userId,
                videoId,
                value,
              },
            });
            const aggregate = await tx.video.update({
              where: { id: videoId },
              data: {
                ratingSum: {
                  increment: value,
                },
                ratingCount: {
                  increment: 1,
                },
              },
              select: {
                ratingSum: true,
                ratingCount: true,
              },
            });

            return toVideoRatingResult(aggregate.ratingSum, aggregate.ratingCount, value);
          }

          const delta = value - currentRating.value;

          if (delta === 0) {
            return toVideoRatingResult(video.ratingSum, video.ratingCount, value);
          }

          await tx.videoRating.update({
            where: {
              userId_videoId: {
                userId,
                videoId,
              },
            },
            data: { value },
          });

          const aggregate = await tx.video.update({
            where: { id: videoId },
            data: {
              ratingSum: {
                increment: delta,
              },
            },
            select: {
              ratingSum: true,
              ratingCount: true,
            },
          });

          return toVideoRatingResult(aggregate.ratingSum, aggregate.ratingCount, value);
        },
        {
          maxAttempts: VIDEO_RATING_TRANSACTION_MAX_ATTEMPTS,
          retryDelayMs: getSerializableTransactionRetryDelayMs,
        },
      );
    } catch (err) {
      if (isPrismaForeignKeyConstraintError(err)) {
        throw new VideoNotFoundError();
      }

      if (isSerializableTransactionConflictError(err)) {
        throw new VideoRatingTemporarilyUnavailableError({ cause: err });
      }

      throw err;
    }
  },

  async getThumbnail({ publicId }: GetVideoThumbnailInput): Promise<VideoThumbnailResult> {
    assertValidPublicHlsVideoId(publicId);

    const video = await deps.prisma.video.findFirst({
      where: {
        publicId,
        ...readableVideoWhere,
        activeArtifactGeneration: {
          is: {
            state: 'active',
          },
        },
      },
      select: {
        thumbnailObjectKey: true,
        activeArtifactGeneration: {
          select: {
            publicToken: true,
            bucket: true,
            thumbnailObjectKey: true,
          },
        },
      },
    });
    const generation = video?.activeArtifactGeneration;

    if (!video || !generation) {
      throw new VideoNotFoundError();
    }

    const objectKey = buildVideoArtifactManifest(generation.publicToken, []).thumbnail.objectKey;

    if (video.thumbnailObjectKey !== objectKey || generation.thumbnailObjectKey !== objectKey) {
      throw new VideoNotFoundError();
    }

    const url = await resolveSignedRedirect(deps.objectStorage, {
      bucket: generation.bucket,
      objectKey,
    });

    if (!url) {
      throw new VideoNotFoundError();
    }

    return {
      url,
    };
  },

  async getHlsMaster({ publicId }: GetVideoHlsMasterInput): Promise<VideoHlsPlaylistResult> {
    assertValidPublicHlsVideoId(publicId);

    const video = await deps.prisma.video.findFirst({
      where: {
        publicId,
        ...readableVideoWhere,
        activeArtifactGeneration: {
          is: {
            state: 'active',
          },
        },
      },
      select: {
        activeArtifactGeneration: {
          select: {
            publicToken: true,
            bucket: true,
            renditions: {
              select: {
                quality: true,
                width: true,
                height: true,
                bitrate: true,
              },
            },
          },
        },
      },
    });
    const generation = video?.activeArtifactGeneration;

    if (!video || !generation || generation.renditions.length === 0) {
      throw new VideoNotFoundError();
    }

    const profiles = generation.renditions.map((rendition) => ({
      quality: toVideoObjectKeyQuality(rendition.quality),
      width: rendition.width,
      height: rendition.height,
      videoBitrate: rendition.bitrate,
    }));
    const manifest = buildVideoArtifactManifest(generation.publicToken, profiles);
    const storedPlaylist = await readForProxy(
      deps.objectStorage,
      {
        bucket: generation.bucket,
        objectKey: manifest.master.objectKey,
      },
      VIDEO_HLS_PLAYLIST_MAX_BYTES,
    );

    if (!storedPlaylist) {
      throw new VideoNotFoundError();
    }

    return {
      playlist: rewriteVideoHlsMasterPlaylist(storedPlaylist.toString('utf8'), {
        publicId,
        generationToken: generation.publicToken,
        qualities: profiles.map(({ quality }) => quality),
      }),
    };
  },

  async getHlsRendition({
    generationToken,
    publicId,
    quality: rawQuality,
  }: GetVideoHlsRenditionInput): Promise<VideoHlsPlaylistResult> {
    const quality = parseVideoHlsQuality(rawQuality);

    if (!quality) {
      throw new VideoNotFoundError();
    }

    const { bucket, rendition } = await findPublicHlsRendition(deps, {
      generationToken,
      publicId,
      quality,
    });
    const storedPlaylist = await readForProxy(
      deps.objectStorage,
      {
        bucket,
        objectKey: rendition.playlistObjectKey,
      },
      VIDEO_HLS_PLAYLIST_MAX_BYTES,
    );

    if (!storedPlaylist) {
      throw new VideoNotFoundError();
    }

    return {
      playlist: rewriteVideoHlsRenditionPlaylist(storedPlaylist.toString('utf8'), {
        publicId,
        generationToken,
        quality,
      }),
    };
  },

  async getHlsSegment({
    generationToken,
    publicId,
    quality: rawQuality,
    segment: rawSegment,
  }: GetVideoHlsSegmentInput): Promise<VideoHlsSegmentResult> {
    const quality = parseVideoHlsQuality(rawQuality);
    const segment = parseVideoHlsSegmentName(rawSegment);

    if (!quality || !segment) {
      throw new VideoNotFoundError();
    }

    const { bucket, rendition } = await findPublicHlsRendition(deps, {
      generationToken,
      publicId,
      quality,
    });
    const objectKey = videoHlsSegmentObjectKey(rendition, segment);
    const url = await resolveSignedRedirect(deps.objectStorage, {
      bucket,
      objectKey,
    });

    if (!url) {
      throw new VideoNotFoundError();
    }

    return {
      url,
    };
  },

  async deleteExpiredVideosPendingPurge(input) {
    return deleteExpiredVideosPendingPurge(deps, input);
  },
});
