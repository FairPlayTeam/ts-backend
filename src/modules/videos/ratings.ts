import { Prisma } from '@prisma/client';
import { isPrismaForeignKeyConstraintError } from '../../services/auth/auth.prismaErrors.js';
import {
  getSerializableTransactionRetryDelayMs,
  isSerializableTransactionConflictError,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import { WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL, readableVideoWhere } from './shared/readability.js';
import { VideoNotFoundError } from './shared/errors.js';
import { VideoRatingTemporarilyUnavailableError, VideoSelfRatingForbiddenError } from './errors.js';
import type { VideosDependencies } from './dependencies.js';
import type {
  GetMyVideoRatingInput,
  GetVideoRatingInput,
  RateVideoInput,
  VideoRatingAggregateResult,
  VideoRatingResult,
  VideosRoutePort,
} from './types.js';

export const calculateVideoRatingAverage = (ratingSum: number, ratingCount: number): number =>
  ratingCount === 0 ? 0 : Math.round((ratingSum / ratingCount) * 10) / 10;

const VIDEO_RATING_TRANSACTION_MAX_ATTEMPTS = 10;

type TransactionClient = Prisma.TransactionClient;

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

export const toVideoRatingResult = (
  ratingSum: number,
  ratingCount: number,
  userRating: number | null,
): VideoRatingResult => ({
  ...toVideoRatingAggregateResult(ratingSum, ratingCount),
  userRating,
});

export const createVideoRatingsService = (deps: VideosDependencies) =>
  ({
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

    async getMyVideoRating({
      publicId,
      userId,
    }: GetMyVideoRatingInput): Promise<VideoRatingResult> {
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
  }) satisfies Pick<VideosRoutePort, 'getVideoRating' | 'getMyVideoRating' | 'rateVideo'>;
