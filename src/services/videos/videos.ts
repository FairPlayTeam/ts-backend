import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  HOUR_MS,
  VIDEO_SOURCE_THUMBNAIL_HEIGHT_PX,
  VIDEO_SOURCE_THUMBNAIL_WIDTH_PX,
} from '../../config/constants.js';
import { ObjectStorageUnavailableError } from '../../lib/objectStorage.js';
import {
  isSerializableTransactionConflictError,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import {
  buildVideoArtifactManifest,
  videoHlsSegmentObjectKey,
  videoOriginalKey,
  videoSourceThumbnailKey,
  type VideoObjectKeyQuality,
} from './videoObjectKeys.js';
import {
  isVideoHlsGenerationId,
  parseVideoHlsQuality,
  parseVideoHlsSegmentName,
  rewriteVideoHlsMasterPlaylist,
  rewriteVideoHlsRenditionPlaylist,
  toVideoObjectKeyQuality,
  toVideoRenditionQuality,
  VIDEO_HLS_PLAYLIST_MAX_BYTES,
} from './videoHls.js';
import { VIDEO_PUBLIC_ID_PATTERN } from './videoPublicId.js';
import {
  createVideoArtifactReconciliationHandler,
  scheduleAbandonedVideoArtifactGenerations,
} from './videoTranscodeRunner.js';
import type { VideosDependencies } from './videos.dependencies.js';
import {
  ExternalResourceNotDesiredError,
  EXTERNAL_RESOURCE_QUIESCENCE_MS,
  ExternalResourceSizeMismatchError,
  requestExternalResourceAbsence,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
  type ExternalResourceReconciliationHandler,
} from '../externalResources.js';
import { isPrismaForeignKeyConstraintError } from '../auth/auth.prismaErrors.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  VideoNotFoundError,
  VideoRatingTemporarilyUnavailableError,
  VideoSelfRatingForbiddenError,
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
  GetMyVideoRatingInput,
  GetPublicVideoDetailInput,
  GetPublicVideoDetailResult,
  GetVideoRatingInput,
  GetVideoHlsMasterInput,
  GetVideoHlsRenditionInput,
  GetVideoHlsSegmentInput,
  GetVideoMultipartUploadSessionInput,
  GetVideoThumbnailInput,
  InitVideoMultipartUploadInput,
  ListPublicVideosInput,
  ListPublicVideosResult,
  ListMyVideosInput,
  ListMyVideosResult,
  PublicVideoCursor,
  PublicVideoSearchSort,
  RateVideoInput,
  SearchPublicVideosInput,
  SearchPublicVideosResult,
  SignVideoMultipartUploadPartsInput,
  SignVideoMultipartUploadPartsResult,
  UploadVideoSourceThumbnailInput,
  UploadVideoSourceThumbnailResult,
  VideoHlsPlaylistResult,
  VideoHlsSegmentResult,
  VideoRatingAggregateResult,
  VideoRatingResult,
  VideoThumbnailResult,
  VideoUploadSession,
  VideoUploadSessionResult,
  VideosService,
} from './types/ports.types.js';
import { calculateVideoRatingAverage, getVideoRatingRetryDelayMs } from './videoRating.js';
import { recordVideoView, toUtcVideoViewDay } from './videoViews.js';
import { buildVideoSearchFilter } from './videoSearch.js';
import {
  readForProxy,
  resolveBestEffortLink,
  resolveSignedRedirect,
  videoHlsMasterPath,
  videoThumbnailPath,
} from '../assets/assetLinks.js';
import { READABLE_VIDEO_SCOPE_SQL, readableVideoWhere } from './videoReadability.js';
import {
  profileMediaAssetSelect,
  toProfileMediaUrl,
} from '../userMedia/userMedia.profileAssets.js';

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
const SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES: readonly VideoUploadSession['status'][] = [
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
const VIDEO_RATING_TRANSACTION_MAX_ATTEMPTS = 10;
const VIDEO_SOURCE_THUMBNAIL_CONTENT_TYPE = 'image/webp';
const VIDEO_SOURCE_THUMBNAIL_CACHE_CONTROL = 'private, no-store';
const DEFAULT_MY_VIDEOS_LIMIT = 20;
const MAX_MY_VIDEOS_LIMIT = 100;
const DEFAULT_PUBLIC_VIDEO_LIST_LIMIT = 20;
const MAX_PUBLIC_VIDEO_LIST_LIMIT = 100;
const MULTIPART_MAINTENANCE_BATCH_SIZE = 100;
const REJECTED_VIDEO_MAINTENANCE_BATCH_SIZE = 100;
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
  thumbnailObjectKey: true,
  ratingSum: true,
  ratingCount: true,
  createdAt: true,
  updatedAt: true,
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
  ratingSum: true,
  ratingCount: true,
  thumbnailObjectKey: true,
  viewCount: true,
  durationSeconds: true,
  publishedAt: true,
  createdAt: true,
  owner: {
    select: {
      username: true,
      displayName: true,
      mediaAssets: {
        where: {
          kind: 'avatar',
        },
        select: profileMediaAssetSelect,
        take: 1,
      },
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
  sourceThumbnail: {
    select: {
      bucket: true,
      externalResourceTargetId: true,
      mimeType: true,
      objectKey: true,
      sizeBytes: true,
      width: true,
      height: true,
      externalResourceTarget: {
        select: {
          bucket: true,
          expectedSizeBytes: true,
          generation: true,
          goal: true,
          role: true,
          selector: true,
          selectorKind: true,
          state: true,
          userId: true,
          videoId: true,
        },
      },
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

const sourceThumbnailSelect = {
  id: true,
  uploadSessionId: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VideoSourceThumbnailSelect;

const completedSourceSessionSelect = {
  id: true,
  userId: true,
  videoId: true,
  status: true,
  sourceThumbnail: uploadSessionSelect.sourceThumbnail,
  _count: {
    select: {
      parts: true,
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

const toUploadVideoSourceThumbnailResult = (
  thumbnail: Prisma.VideoSourceThumbnailGetPayload<{
    select: typeof sourceThumbnailSelect;
  }>,
): UploadVideoSourceThumbnailResult => ({
  thumbnail,
});

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

const PUBLIC_VIDEO_CATALOG_SCOPE = {
  visibility: 'public',
  moderationStatus: 'approved',
  processingStatus: 'ready',
} satisfies Prisma.VideoWhereInput;

type PublicVideoCatalogPageInput = {
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

const queryPublicVideoCatalogPage = async (
  prisma: VideosDependencies['prisma'],
  { cursor, filter, limit, sort = 'newest' }: PublicVideoCatalogPageInput,
): Promise<PublicVideoCatalogPage> => {
  const pageSize = normalizePublicVideoListLimit(limit);
  const direction = sort === 'oldest' ? 'asc' : 'desc';
  const cursorOperator = sort === 'oldest' ? 'gt' : 'lt';
  const resultFilter = filter
    ? ({ AND: [PUBLIC_VIDEO_CATALOG_SCOPE, filter] } satisfies Prisma.VideoWhereInput)
    : PUBLIC_VIDEO_CATALOG_SCOPE;
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
  duration: requireReadyVideoDuration(video.durationSeconds),
  hlsMasterPath: videoHlsMasterPath(video.publicId),
});

type LockedRatableVideo = {
  id: string;
  ownerId: string;
  ratingSum: number;
  ratingCount: number;
};

const RATABLE_VIDEO_SCOPE_SQL = Prisma.sql`
  v."processing_status" = 'ready'
  AND v."moderation_status" <> 'rejected'
  AND v."visibility" IN ('public', 'unlisted')
`;

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
        AND ${RATABLE_VIDEO_SCOPE_SQL}
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

const deleteExpiredRejectedVideo = async (
  deps: VideosDependencies,
  videoId: string,
  observedAt: Date,
  rejectedBefore: Date,
): Promise<{ deleted: boolean; targetsScheduled: number }> =>
  runSerializableTransaction(deps.prisma, async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "video_transcode_jobs"
        WHERE "video_id" = CAST(${videoId} AS UUID)
        FOR UPDATE
      `,
    );
    const eligibleVideos = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"::text AS "id"
        FROM "videos"
        WHERE "id" = CAST(${videoId} AS UUID)
          AND "moderation_status" = 'rejected'
          AND "rejected_at" < ${rejectedBefore}
        FOR UPDATE
      `,
    );

    if (eligibleVideos.length === 0) {
      return { deleted: false, targetsScheduled: 0 };
    }

    const video = await tx.video.findUnique({
      where: { id: videoId },
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
        artifactGenerations: {
          where: {
            state: {
              in: ['writing', 'active', 'retiring'],
            },
          },
          select: {
            id: true,
          },
        },
      },
    });

    if (!video) {
      return { deleted: false, targetsScheduled: 0 };
    }

    const generationIds = video.artifactGenerations.map(({ id }) => id);
    const artifactTargets =
      generationIds.length === 0
        ? []
        : await tx.externalResourceTarget.findMany({
            where: {
              videoId,
              generation: {
                in: generationIds,
              },
              role: {
                in: ['hls_artifacts', 'thumbnail_prefix'],
              },
              state: {
                not: 'confirmed_absent',
              },
            },
            select: {
              id: true,
            },
          });
    const targetIds = [
      ...(video.sourceUploadSession
        ? [
            video.sourceUploadSession.externalResourceTargetId,
            ...(video.sourceUploadSession.sourceThumbnail
              ? [video.sourceUploadSession.sourceThumbnail.externalResourceTargetId]
              : []),
          ]
        : []),
      ...artifactTargets.map(({ id }) => id),
    ];
    let targetsScheduled = 0;

    for (const targetId of new Set(targetIds)) {
      if (await requestExternalResourceAbsence(tx, targetId, observedAt)) {
        targetsScheduled += 1;
      }
    }

    await tx.video.delete({
      where: { id: videoId },
    });

    return { deleted: true, targetsScheduled };
  });

const deleteExpiredRejectedVideos = async (
  deps: VideosDependencies,
  {
    observedAt,
    rejectedBefore,
  }: {
    observedAt: Date;
    rejectedBefore: Date;
  },
): Promise<{
  rejectedVideosDeleted: number;
  rejectedVideoTargetsScheduled: number;
}> => {
  const candidates = await deps.prisma.video.findMany({
    where: {
      moderationStatus: 'rejected',
      rejectedAt: {
        lt: rejectedBefore,
      },
    },
    select: {
      id: true,
    },
    orderBy: [{ rejectedAt: 'asc' }, { id: 'asc' }],
    take: REJECTED_VIDEO_MAINTENANCE_BATCH_SIZE,
  });
  let rejectedVideosDeleted = 0;
  let rejectedVideoTargetsScheduled = 0;

  for (const { id } of candidates) {
    const result = await deleteExpiredRejectedVideo(deps, id, observedAt, rejectedBefore);

    if (result.deleted) {
      rejectedVideosDeleted += 1;
      rejectedVideoTargetsScheduled += result.targetsScheduled;
    }
  }

  return {
    rejectedVideosDeleted,
    rejectedVideoTargetsScheduled,
  };
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
  deps: VideosDependencies,
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

  await deps.prisma.$transaction(async (tx) => {
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
  });

  return findOwnedUploadSession(deps.prisma, {
    uploadSessionId: session.id,
    userId: session.userId,
    videoId: session.videoId,
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
    if (session.sourceThumbnail) {
      await requestExternalResourceAbsence(
        tx,
        session.sourceThumbnail.externalResourceTargetId,
        now,
      );
    }
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

const scheduleVideoSourceThumbnailAbsence = async (
  deps: VideosDependencies,
  targetId: string,
): Promise<void> => {
  const requestedAt = deps.clock.now();

  await runSerializableTransaction(deps.prisma, async (tx) => {
    await requestExternalResourceAbsence(tx, targetId, requestedAt);
  });
};

const createVideoSourceThumbnailReconciliationHandler = (
  deps: VideosDependencies,
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

const assertValidPublicHlsVideoId = (publicId: string): void => {
  if (!VIDEO_PUBLIC_ID_PATTERN.test(publicId)) {
    throw new VideoNotFoundError();
  }
};

const findPublicHlsRendition = async (
  deps: VideosDependencies,
  {
    generationId,
    publicId,
    quality,
  }: {
    generationId: string;
    publicId: string;
    quality: VideoObjectKeyQuality;
  },
) => {
  assertValidPublicHlsVideoId(publicId);

  if (!isVideoHlsGenerationId(generationId)) {
    throw new VideoNotFoundError();
  }

  const persistedQuality = toVideoRenditionQuality(quality);
  const generation = await deps.prisma.videoArtifactGeneration.findFirst({
    where: {
      id: generationId,
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
      id: true,
      bucket: true,
      video: {
        select: {
          id: true,
          ownerId: true,
        },
      },
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

  const manifest = buildVideoArtifactManifest(
    generation.video.ownerId,
    generation.video.id,
    generation.id,
    [
      {
        quality: toVideoObjectKeyQuality(persistedRendition.quality),
        width: persistedRendition.width,
        height: persistedRendition.height,
        bandwidth: persistedRendition.bitrate,
      },
    ],
  );
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
      videos: videos.map(toVideoMetadata),
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

    return {
      videos: page.videos.map(toPublicVideoFeedCard),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  },

  async searchPublicVideos({
    cursor,
    limit,
    search,
    sort = 'newest',
  }: SearchPublicVideosInput): Promise<SearchPublicVideosResult> {
    const searchFilter = buildVideoSearchFilter(search);

    if (!searchFilter) {
      return {
        videos: [],
        total: 0,
        nextCursor: null,
      };
    }

    const page = await queryPublicVideoCatalogPage(deps.prisma, {
      filter: searchFilter,
      sort,
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    });

    return {
      videos: page.videos.map(toPublicVideoSearchSummary),
      total: page.total,
      nextCursor: page.nextCursor,
    };
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
    const [video] = await deps.prisma.$queryRaw<Array<{ ratingCount: number; ratingSum: number }>>(
      Prisma.sql`
        SELECT
          v."rating_sum" AS "ratingSum",
          v."rating_count" AS "ratingCount"
        FROM "videos" AS v
        WHERE v."public_id" = ${publicId}
          AND ${READABLE_VIDEO_SCOPE_SQL}
      `,
    );

    if (!video) {
      throw new VideoNotFoundError();
    }

    return toVideoRatingAggregateResult(video.ratingSum, video.ratingCount);
  },

  async getMyVideoRating({ publicId, userId }: GetMyVideoRatingInput): Promise<VideoRatingResult> {
    const [video] = await deps.prisma.$queryRaw<
      Array<{ ratingCount: number; ratingSum: number; userRating: number | null }>
    >(
      Prisma.sql`
        SELECT
          v."rating_sum" AS "ratingSum",
          v."rating_count" AS "ratingCount",
          vr."value" AS "userRating"
        FROM "videos" AS v
        LEFT JOIN "video_ratings" AS vr
          ON vr."video_id" = v."id"
          AND vr."user_id" = CAST(${userId} AS UUID)
        WHERE v."public_id" = ${publicId}
          AND ${READABLE_VIDEO_SCOPE_SQL}
      `,
    );

    if (!video) {
      throw new VideoNotFoundError();
    }

    return toVideoRatingResult(video.ratingSum, video.ratingCount, video.userRating);
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
          retryDelayMs: getVideoRatingRetryDelayMs,
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
        id: true,
        ownerId: true,
        thumbnailObjectKey: true,
        activeArtifactGeneration: {
          select: {
            id: true,
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

    const objectKey = buildVideoArtifactManifest(video.ownerId, video.id, generation.id, [])
      .thumbnail.objectKey;

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
        id: true,
        ownerId: true,
        activeArtifactGeneration: {
          select: {
            id: true,
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
      bandwidth: rendition.bitrate,
    }));
    const manifest = buildVideoArtifactManifest(video.ownerId, video.id, generation.id, profiles);
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
        generationId: generation.id,
        qualities: profiles.map(({ quality }) => quality),
      }),
    };
  },

  async getHlsRendition({
    generationId,
    publicId,
    quality: rawQuality,
  }: GetVideoHlsRenditionInput): Promise<VideoHlsPlaylistResult> {
    const quality = parseVideoHlsQuality(rawQuality);

    if (!quality) {
      throw new VideoNotFoundError();
    }

    const { bucket, rendition } = await findPublicHlsRendition(deps, {
      generationId,
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
        generationId,
        quality,
      }),
    };
  },

  async getHlsSegment({
    generationId,
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
      generationId,
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
    let reservedSession: { externalResourceTargetId: string };

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

        await assertUserStorageQuota(tx, userId, sizeBytes, deps.config.userStorageQuotaBytes);

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
    const reservedAt = deps.clock.now();
    const target = await runSerializableTransaction(deps.prisma, async (tx) => {
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
      ReturnType<VideosDependencies['externalResources']['reconcileTarget']>
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
        source_thumbnail: createVideoSourceThumbnailReconciliationHandler(deps),
        hls_artifacts: artifactHandler,
        thumbnail_prefix: artifactHandler,
      },
    });
  },

  async deleteExpiredRejectedVideos(input) {
    return deleteExpiredRejectedVideos(deps, input);
  },
});
