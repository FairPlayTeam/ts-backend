import { Prisma, type PrismaClient } from '@prisma/client';
import { PublicProfileNotFoundError } from '../profiles/errors.js';
import { PUBLIC_PROFILE_VISIBILITY_SCOPE } from '../profiles/publicVisibility.js';
import {
  profileAvatarMediaAssetsSelection,
  toProfileMediaUrl,
} from '../../services/userMedia/userMedia.profileAssets.js';
import {
  resolveBestEffortLink,
  videoHlsMasterPath,
  videoThumbnailPath,
} from '../../services/assets/assetLinks.js';
import {
  isVideoWritableEngagement,
  publicVideoCatalogWhere,
  readableVideoWhere,
} from './shared/readability.js';
import {
  PUBLIC_CREATOR_SEARCH_LIMIT,
  buildPublicCreatorSearchCriteria,
  buildVideoSearchFilter,
} from './shared/search.js';
import { calculateVideoRatingAverage, toVideoRatingResult } from './ratings.js';
import { assertValidPublicVideoId } from './shared/publicId.js';
import type { VideosDependencies } from './dependencies.js';
import type {
  GetPublicVideoDetailInput,
  GetPublicVideoDetailResult,
  ListPublicProfileVideosInput,
  ListPublicVideosInput,
  ListPublicVideosResult,
  PublicCreatorSearchSummary,
  PublicVideoCursor,
  PublicVideoSearchSort,
  SearchPublicVideosInput,
  SearchPublicVideosResult,
  VideosRoutePort,
} from './types.js';
import { VideoNotFoundError } from './shared/errors.js';

const DEFAULT_PUBLIC_VIDEO_LIST_LIMIT = 20;

const MAX_PUBLIC_VIDEO_LIST_LIMIT = 100;

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

const publicCreatorSearchSelect = {
  username: true,
  displayName: true,
  createdAt: true,
  mediaAssets: profileAvatarMediaAssetsSelection,
  _count: {
    select: {
      followers: true,
      videos: {
        where: publicVideoCatalogWhere,
      },
    },
  },
} satisfies Prisma.UserSelect;

export type PublicCreatorSearchRecord = Prisma.UserGetPayload<{
  select: typeof publicCreatorSearchSelect;
}>;

type PublicCreatorSearchFindExactArgs = {
  where: Prisma.UserWhereInput;
  select: typeof publicCreatorSearchSelect;
};

type PublicCreatorSearchFindPartialArgs = PublicCreatorSearchFindExactArgs & {
  orderBy: Prisma.UserOrderByWithRelationInput;
  take: number;
};

export type PublicCreatorSearchReader = {
  findExact(args: PublicCreatorSearchFindExactArgs): Promise<PublicCreatorSearchRecord | null>;
  findPartial(args: PublicCreatorSearchFindPartialArgs): Promise<PublicCreatorSearchRecord[]>;
};

export type PublicCreatorSearchTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel;
};

export type PublicCreatorSearchTransactionRunner = {
  run<T>(
    callback: (reader: PublicCreatorSearchReader) => Promise<T>,
    options: PublicCreatorSearchTransactionOptions,
  ): Promise<T>;
};

const toPublicCreatorSearchReader = (
  tx: Pick<Prisma.TransactionClient, 'user'>,
): PublicCreatorSearchReader => ({
  findExact: (args) => tx.user.findFirst(args),
  findPartial: (args) => tx.user.findMany(args),
});

export const createPublicCreatorSearchTransactionRunner = (
  prisma: Pick<PrismaClient, '$transaction'>,
): PublicCreatorSearchTransactionRunner => ({
  run: (callback, options) =>
    prisma.$transaction((tx) => callback(toPublicCreatorSearchReader(tx)), options),
});

type PublicCreatorSearchRecords = {
  exactMatch: PublicCreatorSearchRecord | null;
  partialMatches: PublicCreatorSearchRecord[];
};

const toPublicCreatorSearchSummary = ({
  _count,
  createdAt,
  displayName,
  mediaAssets,
  username,
}: PublicCreatorSearchRecord): PublicCreatorSearchSummary => ({
  username,
  displayName,
  avatarUrl: toProfileMediaUrl(username, 'avatar', mediaAssets[0]),
  followerCount: _count.followers,
  videoCount: _count.videos,
  createdAt,
});

const queryPublicCreatorSearchRecords = async (
  reader: PublicCreatorSearchReader,
  exactUsername: string,
  partialSearchFilter: Prisma.UserWhereInput,
): Promise<PublicCreatorSearchRecords> => {
  const exactMatch = await reader.findExact({
    where: {
      ...PUBLIC_PROFILE_VISIBILITY_SCOPE,
      username: exactUsername,
    },
    select: publicCreatorSearchSelect,
  });
  const partialMatches = await reader.findPartial({
    where: {
      AND: [
        PUBLIC_PROFILE_VISIBILITY_SCOPE,
        partialSearchFilter,
        {
          NOT: {
            username: exactUsername,
          },
        },
      ],
    },
    select: publicCreatorSearchSelect,
    orderBy: {
      username: 'asc',
    },
    take: exactMatch ? PUBLIC_CREATOR_SEARCH_LIMIT - 1 : PUBLIC_CREATOR_SEARCH_LIMIT,
  });

  return { exactMatch, partialMatches };
};

export const searchPublicCreators = async (
  transactionRunner: PublicCreatorSearchTransactionRunner,
  search: string | undefined,
): Promise<PublicCreatorSearchSummary[]> => {
  const criteria = buildPublicCreatorSearchCriteria(search);

  if (!criteria) {
    return [];
  }

  const { exactMatch, partialMatches } = await transactionRunner.run(
    (reader) =>
      queryPublicCreatorSearchRecords(reader, criteria.exactUsername, criteria.partialFilter),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );

  const distinctPartialMatches = exactMatch
    ? partialMatches.filter(
        ({ username }) => username.toLowerCase() !== exactMatch.username.toLowerCase(),
      )
    : partialMatches;

  return [...(exactMatch ? [exactMatch] : []), ...distinctPartialMatches]
    .slice(0, PUBLIC_CREATOR_SEARCH_LIMIT)
    .map(toPublicCreatorSearchSummary);
};

export type PublicVideoSearchPageInput = {
  cursor?: PublicVideoCursor;
  filter: Prisma.VideoWhereInput;
  limit?: number;
  sort: PublicVideoSearchSort;
};

type PublicVideoSearchPageResult = Omit<SearchPublicVideosResult, 'creators'>;

export type PublicVideoSearchDependencies = {
  queryVideoPage(input: PublicVideoSearchPageInput): Promise<PublicVideoSearchPageResult>;
  searchCreators(search: string | undefined): Promise<SearchPublicVideosResult['creators']>;
};

export const searchPublicVideoCatalog = async (
  deps: PublicVideoSearchDependencies,
  { cursor, limit, search, sort = 'newest' }: SearchPublicVideosInput,
): Promise<SearchPublicVideosResult> => {
  const searchFilter = buildVideoSearchFilter(search);

  if (!searchFilter) {
    return {
      videos: [],
      creators: [],
      total: 0,
      nextCursor: null,
    };
  }

  const [page, creators] = await Promise.all([
    deps.queryVideoPage({
      filter: searchFilter,
      sort,
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    }),
    deps.searchCreators(search),
  ]);

  return {
    ...page,
    creators,
  };
};

type VideoViewWriter = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type RecordVideoViewInput = {
  userId: string;
  videoId: string;
  viewedOn: string;
};

export const toUtcVideoViewDay = (date: Date): string => date.toISOString().slice(0, 10);

export const recordVideoView = async (
  prisma: VideoViewWriter,
  { userId, videoId, viewedOn }: RecordVideoViewInput,
): Promise<boolean> => {
  const updatedVideos = await prisma.$executeRaw(
    Prisma.sql`
      WITH inserted_view AS (
        INSERT INTO "video_views" ("user_id", "video_id", "viewed_on")
        SELECT
          CAST(${userId} AS UUID),
          v."id",
          CAST(${viewedOn} AS DATE)
        FROM "videos" AS v
        WHERE v."id" = CAST(${videoId} AS UUID)
          AND v."owner_id" <> CAST(${userId} AS UUID)
        ON CONFLICT ("user_id", "video_id", "viewed_on") DO NOTHING
        RETURNING "video_id"
      )
      UPDATE "videos" AS v
      SET "view_count" = v."view_count" + 1
      FROM inserted_view AS inserted
      WHERE v."id" = inserted."video_id"
    `,
  );

  return updatedVideos === 1;
};

export const createVideoCatalogService = (deps: VideosDependencies) =>
  ({
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
            searchPublicCreators(
              createPublicCreatorSearchTransactionRunner(deps.prisma),
              searchTerm,
            ),
        },
        input,
      );
    },

    async getPublicVideoDetail({
      publicId,
      userId,
    }: GetPublicVideoDetailInput): Promise<GetPublicVideoDetailResult> {
      assertValidPublicVideoId(publicId);

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
  }) satisfies Pick<
    VideosRoutePort,
    'listPublicVideos' | 'listPublicProfileVideos' | 'searchPublicVideos' | 'getPublicVideoDetail'
  >;
