import type { Prisma } from '@prisma/client';
import { constraintContains, isPrismaUniqueError } from '../../lib/prismaErrors.js';
import { resolveBestEffortLink, videoThumbnailPath } from '../../services/assets/assetLinks.js';
import { calculateVideoRatingAverage } from './ratings.js';
import type { VideosDependencies } from './dependencies.js';
import type {
  CreateVideoInput,
  CreateVideoResult,
  DeleteVideoInput,
  ListMyVideosInput,
  ListMyVideosResult,
  VideosRoutePort,
} from './types.js';
import { deleteOwnedVideo } from './lifecycle.js';

const DEFAULT_MY_VIDEOS_LIMIT = 20;

const MAX_MY_VIDEOS_LIMIT = 100;

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

const myVideoSelect = {
  ...videoSelect,
  deletionRequestedAt: true,
} satisfies Prisma.VideoSelect;

type VideoMetadataRecord = Prisma.VideoGetPayload<{
  select: typeof videoSelect;
}>;

type MyVideoMetadataRecord = Prisma.VideoGetPayload<{
  select: typeof myVideoSelect;
}>;

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

const normalizeOptionalDescription = (description: string | null | undefined): string | null => {
  const normalizedDescription = description?.trim();

  return normalizedDescription ? normalizedDescription : null;
};

export const createVideoManagementService = (deps: VideosDependencies) =>
  ({
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
                { createdAt: cursor.createdAt, publicId: { lt: cursor.publicId } },
              ],
            }
          : {}),
      } satisfies Prisma.VideoWhereInput;

      const [queriedVideos, total] = await deps.prisma.$transaction([
        deps.prisma.video.findMany({
          where: pageFilter,
          select: myVideoSelect,
          orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
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
          ? { createdAt: lastVideo.createdAt, publicId: lastVideo.publicId }
          : null;

      return {
        videos: videos.map(toMyVideoMetadata),
        total,
        nextCursor,
      };
    },
  }) satisfies Pick<VideosRoutePort, 'createVideo' | 'deleteVideo' | 'listMyVideos'>;
