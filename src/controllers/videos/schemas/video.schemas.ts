import { z } from '../../../docs/zod.js';
import { VIDEO_LICENSES } from '../../../services/videos/videoLicenses.js';
import { VIDEO_HLS_SEGMENT_NAME_PATTERN } from '../../../services/videos/videoObjectKeys.js';
import { VIDEO_PUBLIC_ID_PATTERN } from '../../../services/videos/videoPublicId.js';
import { VIDEO_HLS_GENERATION_TOKEN_PATTERN } from '../../../services/videos/videoHls.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';
import { publicProfileIdentityResponseSchema } from '../../shared/profile.schemas.js';
import { publicVideoSearchTextSchema } from '../../shared/search.schemas.js';
import { PUBLIC_CREATOR_SEARCH_LIMIT } from '../../../services/videos/videoSearch.js';

const VIDEO_TITLE_MAX_LENGTH = 120;
const VIDEO_DESCRIPTION_MAX_LENGTH = 5_000;
const VIDEO_TAG_MAX_LENGTH = 40;
const VIDEO_TAGS_MAX_COUNT = 20;

export const MY_VIDEOS_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorId must be provided together';
export const PUBLIC_VIDEO_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorPublicId must be provided together';

export const publicVideoIdParamsSchema = z
  .object({
    publicId: z.string().regex(VIDEO_PUBLIC_ID_PATTERN).openapi({ example: 'AbCdEf123_' }),
  })
  .strict()
  .openapi('PublicVideoIdParams');

export const videoRatingParamsSchema = publicVideoIdParamsSchema.openapi('VideoRatingParams');

export const videoHlsRenditionParamsSchema = publicVideoIdParamsSchema
  .extend({
    generationToken: z.string().regex(VIDEO_HLS_GENERATION_TOKEN_PATTERN).openapi({
      example: '7f8a9b0c1d2e3f405162738495a6b7c87f8a9b0c1d2e3f405162738495a6b7c8',
    }),
    quality: z.enum(['240p', '480p', '720p', '1080p']).openapi({ example: '720p' }),
  })
  .openapi('VideoHlsRenditionParams');

export const videoHlsSegmentParamsSchema = videoHlsRenditionParamsSchema
  .extend({
    segment: z
      .string()
      .regex(VIDEO_HLS_SEGMENT_NAME_PATTERN)
      .openapi({ example: 'segment-00001.ts' }),
  })
  .openapi('VideoHlsSegmentParams');

const videoVisibilitySchema = z.enum(['public', 'unlisted']);
const videoLicenseSchema = z.enum(VIDEO_LICENSES);

const videoTagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, 'Video tags must not be empty')
      .max(VIDEO_TAG_MAX_LENGTH, `Video tags must be at most ${VIDEO_TAG_MAX_LENGTH} characters`),
  )
  .max(VIDEO_TAGS_MAX_COUNT, `Videos can have at most ${VIDEO_TAGS_MAX_COUNT} tags`)
  .default([])
  .transform((tags) => [...new Set(tags)]);

export const createVideoBodySchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Video title must not be empty')
      .max(
        VIDEO_TITLE_MAX_LENGTH,
        `Video title must be at most ${VIDEO_TITLE_MAX_LENGTH} characters`,
      )
      .openapi({ example: 'Me at the zoo' }),
    description: z
      .string()
      .trim()
      .max(
        VIDEO_DESCRIPTION_MAX_LENGTH,
        `Video description must be at most ${VIDEO_DESCRIPTION_MAX_LENGTH} characters`,
      )
      .nullable()
      .optional()
      .openapi({ example: '00:00 Intro 00:05 The cool thing 00:17 End.' }),
    tags: videoTagsSchema.openapi({ example: ['zoo', 'elephants'] }),
    license: videoLicenseSchema
      .default('all_rights_reserved')
      .openapi({ example: 'all_rights_reserved' }),
    allowComments: z.boolean().default(true).openapi({
      description:
        'Whether comments are allowed on this video. Defaults to true and is fixed at creation in this API version.',
      example: true,
    }),
  })
  .strict()
  .openapi('CreateVideoRequest');

export const rateVideoBodySchema = z
  .object({
    value: z.number().int().min(1).max(5).openapi({ example: 5 }),
  })
  .strict()
  .openapi('RateVideoRequest');

export const myVideosQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    cursorCreatedAt: z.string().datetime().optional().openapi({
      example: '2026-01-01T00:00:00.000Z',
    }),
    cursorId: z
      .string()
      .uuid('Cursor video id must be a valid UUID')
      .optional()
      .openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  })
  .strict()
  .refine((query) => (query.cursorCreatedAt === undefined) === (query.cursorId === undefined), {
    message: MY_VIDEOS_CURSOR_PAIR_MESSAGE,
  })
  .openapi('MyVideosQuery');

const publicVideoPaginationQueryShape = {
  limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
  cursorCreatedAt: z.string().datetime().optional().openapi({
    example: '2026-01-01T00:00:00.000Z',
  }),
  cursorPublicId: z
    .string()
    .regex(VIDEO_PUBLIC_ID_PATTERN, 'Cursor video public id must be valid')
    .optional()
    .openapi({ example: 'AbCdEf123_' }),
};

const hasCompletePublicVideoCursor = (query: {
  cursorCreatedAt?: string | undefined;
  cursorPublicId?: string | undefined;
}): boolean => (query.cursorCreatedAt === undefined) === (query.cursorPublicId === undefined);

export const publicVideosQuerySchema = z
  .object(publicVideoPaginationQueryShape)
  .strict()
  .refine(hasCompletePublicVideoCursor, {
    message: PUBLIC_VIDEO_CURSOR_PAIR_MESSAGE,
  })
  .openapi('PublicVideosQuery');

export const publicVideoSearchQuerySchema = z
  .object({
    ...publicVideoPaginationQueryShape,
    search: publicVideoSearchTextSchema.openapi({
      example: 'launch recap',
      description:
        "Runs two independent searches: videos match case-insensitive literal title/description substrings or an exact tag, while creators match case-insensitive literal username/display-name substrings. Creator matches never add that creator's videos to the videos section.",
    }),
    sort: z.enum(['newest', 'oldest']).optional().openapi({
      example: 'newest',
      description: 'Sort by creation time. Defaults to newest.',
    }),
  })
  .strict()
  .refine(hasCompletePublicVideoCursor, {
    message: PUBLIC_VIDEO_CURSOR_PAIR_MESSAGE,
  })
  .openapi('PublicVideoSearchQuery');

const videoRatingAggregateResponseShape = {
  ratingAverage: z.number().min(0).max(5).openapi({
    description: 'Arithmetic mean rounded to one decimal place, or zero when unrated',
    example: 4.3,
  }),
  ratingCount: z.number().int().nonnegative().openapi({ example: 12 }),
};

const videoResponseBodySchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  publicId: z.string().openapi({ example: 'AbCdEf123_' }),
  ownerId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  title: z.string().openapi({ example: 'Me at the zoo' }),
  description: z
    .string()
    .nullable()
    .openapi({ example: '00:00 Intro 00:05 The cool thing 00:17 End.' }),
  tags: z.array(z.string()).openapi({ example: ['zoo', 'elephants'] }),
  license: videoLicenseSchema.openapi({ example: 'all_rights_reserved' }),
  visibility: videoVisibilitySchema.openapi({ example: 'unlisted' }),
  allowComments: z.boolean().openapi({
    description:
      'Persisted comment preference selected at creation; this API version does not expose an update route.',
    example: true,
  }),
  processingStatus: z
    .enum(['draft', 'uploading', 'queued', 'processing', 'ready', 'failed'])
    .openapi({
      example: 'draft',
    }),
  moderationStatus: z.enum(['pending', 'approved', 'rejected']).openapi({ example: 'pending' }),
  thumbnailPath: relativeAssetPathSchema
    .nullable()
    .openapi({ example: '/videos/AbCdEf123_/thumbnail' }),
  ...videoRatingAggregateResponseShape,
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  updatedAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

export const createVideoResponseSchema = z
  .object({
    video: videoResponseBodySchema,
  })
  .openapi('CreateVideoResponse');

const myVideoResponseBodySchema = videoResponseBodySchema.extend({
  deletionRequestedAt: z.string().datetime().nullable().openapi({
    description:
      'When set, the video is hidden from discovery and scheduled for permanent deletion after the retention period.',
    example: null,
  }),
});

export const myVideosResponseSchema = z
  .object({
    videos: z.array(myVideoResponseBodySchema),
    total: z.number().int().nonnegative().openapi({ example: 42 }),
    nextCursor: z
      .object({
        createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
        id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
      })
      .nullable(),
  })
  .openapi('MyVideosResponse');

const publicVideoSearchSummaryResponseSchema = z.object({
  publicId: z.string().openapi({ example: 'AbCdEf123_' }),
  title: z.string().openapi({ example: 'Me at the zoo' }),
  description: z
    .string()
    .nullable()
    .openapi({ example: '00:00 Intro 00:05 The cool thing 00:17 End.' }),
  tags: z.array(z.string()).openapi({ example: ['zoo', 'elephants'] }),
  username: z.string().openapi({ example: 'jawed' }),
  thumbnailPath: relativeAssetPathSchema
    .nullable()
    .openapi({ example: '/videos/AbCdEf123_/thumbnail' }),
  ...videoRatingAggregateResponseShape,
  publishedAt: z.string().datetime().nullable().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const publicCreatorSearchSummaryResponseSchema = publicProfileIdentityResponseSchema
  .extend({
    followerCount: z.number().int().nonnegative().openapi({ example: 128 }),
    videoCount: z.number().int().nonnegative().openapi({ example: 24 }),
    createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  })
  .openapi('PublicCreatorSearchSummary');

const publicVideoDetailResponseBodySchema = publicVideoSearchSummaryResponseSchema
  .pick({
    publicId: true,
    title: true,
    description: true,
    tags: true,
    ratingAverage: true,
    ratingCount: true,
    thumbnailPath: true,
    publishedAt: true,
    createdAt: true,
  })
  .extend({
    license: videoLicenseSchema.openapi({ example: 'all_rights_reserved' }),
    visibility: videoVisibilitySchema.openapi({ example: 'unlisted' }),
    commentsOpen: z.boolean().openapi({
      description:
        'Whether new comments can currently be posted. Existing comments may remain readable when this is false.',
      example: true,
    }),
    creator: publicProfileIdentityResponseSchema,
    userRating: z.number().int().min(1).max(5).nullable().openapi({ example: 5 }),
    viewCount: z.number().int().nonnegative().openapi({ example: 128 }),
    commentCount: z.number().int().nonnegative().openapi({
      description:
        'Number of active comments, including roots and replies but excluding tombstones.',
      example: 42,
    }),
    duration: z.number().int().positive().openapi({ example: 19 }),
    hlsMasterPath: relativeAssetPathSchema.openapi({
      example: '/videos/AbCdEf123_/hls/master.m3u8',
    }),
  });

export const publicVideoDetailResponseSchema = z
  .object({
    video: publicVideoDetailResponseBodySchema,
  })
  .openapi('PublicVideoDetailResponse');

const publicVideoNextCursorResponseSchema = z
  .object({
    createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
    publicId: z.string().regex(VIDEO_PUBLIC_ID_PATTERN).openapi({ example: 'AbCdEf123_' }),
  })
  .nullable();

export const publicVideoSearchResponseSchema = z
  .object({
    videos: z.array(publicVideoSearchSummaryResponseSchema),
    creators: z
      .array(publicCreatorSearchSummaryResponseSchema)
      .max(PUBLIC_CREATOR_SEARCH_LIMIT)
      .openapi({
        description: `Up to ${PUBLIC_CREATOR_SEARCH_LIMIT} matching public creators. Exact username matches appear first, followed by partial matches ordered by username.`,
      }),
    total: z.number().int().nonnegative().openapi({
      description: 'Total number of matching videos. Creator matches are not included.',
      example: 42,
    }),
    nextCursor: publicVideoNextCursorResponseSchema.openapi({
      description: 'Cursor for the next page of videos. Creator matches are not paginated.',
    }),
  })
  .openapi('PublicVideoSearchResponse');

const publicVideoFeedCardResponseSchema = z.object({
  publicId: z.string().regex(VIDEO_PUBLIC_ID_PATTERN).openapi({ example: 'AbCdEf123_' }),
  title: z.string().openapi({ example: 'Me at the zoo' }),
  createdAt: z.string().datetime().openapi({ example: '2005-04-23T20:31:52.000Z' }),
  thumbnailPath: relativeAssetPathSchema
    .nullable()
    .openapi({ example: '/videos/AbCdEf123_/thumbnail' }),
  creator: publicProfileIdentityResponseSchema.omit({ avatarUrl: true }),
  viewCount: z.number().int().nonnegative().openapi({ example: 128 }),
  duration: z.number().int().positive().openapi({ example: 19 }),
});

export const publicVideosResponseSchema = z
  .object({
    videos: z.array(publicVideoFeedCardResponseSchema),
    total: z.number().int().nonnegative().openapi({ example: 42 }),
    nextCursor: publicVideoNextCursorResponseSchema,
  })
  .openapi('PublicVideosResponse');

export const videoRatingAggregateResponseSchema = z
  .object(videoRatingAggregateResponseShape)
  .openapi('VideoRatingAggregateResponse');

export const videoRatingResponseSchema = videoRatingAggregateResponseSchema
  .extend({
    userRating: z.number().int().min(1).max(5).nullable().openapi({ example: 5 }),
  })
  .openapi('VideoRatingResponse');

export const createVideoSchema = z.object({
  body: createVideoBodySchema,
});

export const listMyVideosSchema = z.object({
  query: myVideosQuerySchema,
});

export const listPublicVideosSchema = z.object({
  query: publicVideosQuerySchema,
});

export const searchPublicVideosSchema = z.object({
  query: publicVideoSearchQuerySchema,
});

export const getPublicVideoDetailSchema = z.object({
  params: publicVideoIdParamsSchema,
});

export const deleteVideoSchema = getPublicVideoDetailSchema;

export const getVideoRatingSchema = z.object({
  params: videoRatingParamsSchema,
});

export const rateVideoSchema = z.object({
  params: videoRatingParamsSchema,
  body: rateVideoBodySchema,
});

export type PublicVideoIdParams = z.infer<typeof publicVideoIdParamsSchema>;
export type VideoRatingParams = z.infer<typeof videoRatingParamsSchema>;
export type VideoThumbnailParams = PublicVideoIdParams;
export type VideoHlsRenditionParams = z.infer<typeof videoHlsRenditionParamsSchema>;
export type VideoHlsSegmentParams = z.infer<typeof videoHlsSegmentParamsSchema>;
export type CreateVideoBody = z.infer<typeof createVideoSchema>['body'];
export type RateVideoBody = z.infer<typeof rateVideoSchema>['body'];
export type ListMyVideosQuery = z.infer<typeof listMyVideosSchema>['query'];
export type ListPublicVideosQuery = z.infer<typeof listPublicVideosSchema>['query'];
export type SearchPublicVideosQuery = z.infer<typeof searchPublicVideosSchema>['query'];
