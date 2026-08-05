import { z } from '../../../docs/zod.js';
import { VIDEO_LICENSES } from '../../../services/videos/videoLicenses.js';
import { VIDEO_HLS_SEGMENT_NAME_PATTERN } from '../../../services/videos/videoObjectKeys.js';
import { VIDEO_PUBLIC_ID_PATTERN } from '../../../services/videos/videoPublicId.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';

const VIDEO_TITLE_MAX_LENGTH = 120;
const VIDEO_DESCRIPTION_MAX_LENGTH = 5_000;
const VIDEO_TAG_MAX_LENGTH = 40;
const VIDEO_TAGS_MAX_COUNT = 20;

export const MY_VIDEOS_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorId must be provided together';
export const PUBLIC_VIDEO_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorPublicId must be provided together';

export const videoParamsSchema = z
  .object({
    videoId: z.string().uuid('Video id must be a valid UUID').openapi({
      example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    }),
  })
  .strict()
  .openapi('VideoParams');

export const videoMultipartUploadSessionParamsSchema = videoParamsSchema
  .extend({
    uploadSessionId: z.string().uuid('Upload session id must be a valid UUID').openapi({
      example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    }),
  })
  .openapi('VideoMultipartUploadSessionParams');

export const publicVideoIdParamsSchema = z
  .object({
    publicId: z.string().regex(VIDEO_PUBLIC_ID_PATTERN).openapi({ example: 'AbCdEf123_' }),
  })
  .strict()
  .openapi('PublicVideoIdParams');

export const videoRatingParamsSchema = publicVideoIdParamsSchema.openapi('VideoRatingParams');

export const videoHlsRenditionParamsSchema = publicVideoIdParamsSchema
  .extend({
    generationId: z.string().uuid().openapi({
      example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    }),
    quality: z.enum(['480p', '720p', '1080p']).openapi({ example: '720p' }),
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

const partNumberSchema = z.number().int().min(1).max(10_000).openapi({ example: 1 });

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

const distinctPartNumbers = (partNumbers: readonly number[]): boolean =>
  new Set(partNumbers).size === partNumbers.length;

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
    visibility: videoVisibilitySchema.default('unlisted').openapi({ example: 'public' }),
    allowComments: z.boolean().default(true).openapi({ example: true }),
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
    search: z
      .string()
      .trim()
      .min(2, 'Video search must be at least 2 characters')
      .max(254, 'Video search must be at most 254 characters')
      .refine((search) => !search.includes('\u0000'), {
        message: 'Video search must not contain NUL characters',
      })
      .openapi({
        example: 'launch recap',
        description:
          'Case-insensitive literal substring search over public video titles and descriptions, plus exact tag matching.',
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

export const signVideoMultipartUploadPartsBodySchema = z
  .object({
    partNumbers: z.array(partNumberSchema).min(1).max(100).refine(distinctPartNumbers, {
      message: 'Part numbers must be unique',
    }),
  })
  .strict()
  .openapi('SignVideoMultipartUploadPartsRequest');

const uploadPartSchema = z.object({
  partNumber: partNumberSchema,
  etag: z.string().trim().min(1).max(255).openapi({ example: '"abc123"' }),
});

export const completeVideoMultipartUploadBodySchema = z
  .object({
    parts: z
      .array(uploadPartSchema)
      .min(1)
      .max(10_000)
      .refine((parts) => distinctPartNumbers(parts.map((part) => part.partNumber)), {
        message: 'Completed upload parts must use unique part numbers',
      }),
  })
  .strict()
  .openapi('CompleteVideoMultipartUploadRequest');

export const initVideoMultipartUploadBodySchema = z
  .object({
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .openapi({ example: 1_073_741_824 }),
  })
  .strict()
  .openapi('InitVideoMultipartUploadRequest');

export const initVideoMultipartUploadSchema = z.object({
  params: videoParamsSchema,
  body: initVideoMultipartUploadBodySchema,
});

export const signVideoMultipartUploadPartsSchema = z.object({
  params: videoMultipartUploadSessionParamsSchema,
  body: signVideoMultipartUploadPartsBodySchema,
});

export const completeVideoMultipartUploadSchema = z.object({
  params: videoMultipartUploadSessionParamsSchema,
  body: completeVideoMultipartUploadBodySchema,
});

export const abortVideoMultipartUploadSchema = z.object({
  params: videoMultipartUploadSessionParamsSchema,
});

export const getVideoMultipartUploadSessionSchema = z.object({
  params: videoMultipartUploadSessionParamsSchema,
});

export const uploadVideoSourceThumbnailSchema = z.object({
  params: videoMultipartUploadSessionParamsSchema,
});

export const uploadVideoSourceThumbnailBodySchema = z
  .object({
    thumbnail: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'JPEG, PNG, or WebP image normalized to a 1280x720 WebP.',
    }),
  })
  .openapi('UploadVideoSourceThumbnailRequest');

const videoUploadPartResponseSchema = z.object({
  partNumber: z.number().int().positive().openapi({ example: 1 }),
  etag: z.string().openapi({ example: '"abc123"' }),
  sizeBytes: z.number().int().positive().nullable().openapi({ example: null }),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

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
  allowComments: z.boolean().openapi({ example: true }),
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

export const myVideosResponseSchema = z
  .object({
    videos: z.array(videoResponseBodySchema),
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
    creator: z.object({
      username: z.string().openapi({ example: 'jawed' }),
      displayName: z.string().nullable().openapi({ example: 'Jawed Karim' }),
      avatarUrl: relativeAssetPathSchema.nullable().openapi({ example: '/profiles/jawed/avatar' }),
    }),
    userRating: z.number().int().min(1).max(5).nullable().openapi({ example: 5 }),
    viewCount: z.number().int().nonnegative().openapi({ example: 128 }),
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
    total: z.number().int().nonnegative().openapi({ example: 42 }),
    nextCursor: publicVideoNextCursorResponseSchema,
  })
  .openapi('PublicVideoSearchResponse');

const publicVideoFeedCardResponseSchema = z.object({
  publicId: z.string().regex(VIDEO_PUBLIC_ID_PATTERN).openapi({ example: 'AbCdEf123_' }),
  title: z.string().openapi({ example: 'Me at the zoo' }),
  createdAt: z.string().datetime().openapi({ example: '2005-04-23T20:31:52.000Z' }),
  thumbnailPath: relativeAssetPathSchema
    .nullable()
    .openapi({ example: '/videos/AbCdEf123_/thumbnail' }),
  creator: z.object({
    username: z.string().openapi({ example: 'jawed' }),
    displayName: z.string().nullable().openapi({ example: 'Jawed Karim' }),
  }),
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

const videoUploadSessionResponseBodySchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  videoId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  status: z
    .enum([
      'initializing',
      'initiated',
      'uploading',
      'completing',
      'completed',
      'aborting',
      'aborted',
      'expiring',
      'expired',
    ])
    .openapi({
      example: 'initiated',
    }),
  bucket: z.string().openapi({ example: 'videos' }),
  objectKey: z.string().openapi({
    example:
      '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f/video-uuid/sources/upload-session-uuid/original.mp4',
  }),
  uploadId: z.string().nullable().openapi({ example: 'multipart-upload-id' }),
  partSizeBytes: z.number().int().positive().openapi({ example: 67_108_864 }),
  expectedSizeBytes: z.number().int().positive().openapi({ example: 1_073_741_824 }),
  partCount: z.number().int().nonnegative().nullable().openapi({ example: null }),
  expiresAt: z.string().datetime().openapi({ example: '2026-01-02T00:00:00.000Z' }),
  completedAt: z.string().datetime().nullable().openapi({ example: null }),
  abortedAt: z.string().datetime().nullable().openapi({ example: null }),
  expiredAt: z.string().datetime().nullable().openapi({ example: null }),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  updatedAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  parts: z.array(videoUploadPartResponseSchema),
});

export const videoUploadSessionResponseSchema = z
  .object({
    uploadSession: videoUploadSessionResponseBodySchema,
  })
  .openapi('VideoUploadSessionResponse');

export const signedVideoUploadPartsResponseSchema = z
  .object({
    uploadSessionId: z.string().uuid().openapi({
      example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    }),
    parts: z.array(
      z.object({
        partNumber: z.number().int().positive().openapi({ example: 1 }),
        url: z.string().url().openapi({
          example:
            'http://localhost:9000/videos/user-id/video-id/sources/session-id/original.mp4?partNumber=1&uploadId=...',
        }),
      }),
    ),
  })
  .openapi('SignedVideoUploadPartsResponse');

export const uploadVideoSourceThumbnailResponseSchema = z
  .object({
    thumbnail: z.object({
      id: z.string().uuid(),
      uploadSessionId: z.string().uuid(),
      mimeType: z.literal('image/webp'),
      sizeBytes: z.number().int().positive(),
      width: z.literal(1280),
      height: z.literal(720),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  })
  .openapi('UploadVideoSourceThumbnailResponse');

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

export const getVideoRatingSchema = z.object({
  params: videoRatingParamsSchema,
});

export const rateVideoSchema = z.object({
  params: videoRatingParamsSchema,
  body: rateVideoBodySchema,
});

export type VideoParams = z.infer<typeof initVideoMultipartUploadSchema>['params'];
export type PublicVideoIdParams = z.infer<typeof publicVideoIdParamsSchema>;
export type VideoRatingParams = z.infer<typeof videoRatingParamsSchema>;
export type VideoThumbnailParams = PublicVideoIdParams;
export type VideoHlsRenditionParams = z.infer<typeof videoHlsRenditionParamsSchema>;
export type VideoHlsSegmentParams = z.infer<typeof videoHlsSegmentParamsSchema>;
export type InitVideoMultipartUploadBody = z.infer<typeof initVideoMultipartUploadSchema>['body'];
export type VideoMultipartUploadSessionParams = z.infer<
  typeof getVideoMultipartUploadSessionSchema
>['params'];
export type CreateVideoBody = z.infer<typeof createVideoSchema>['body'];
export type RateVideoBody = z.infer<typeof rateVideoSchema>['body'];
export type ListMyVideosQuery = z.infer<typeof listMyVideosSchema>['query'];
export type ListPublicVideosQuery = z.infer<typeof listPublicVideosSchema>['query'];
export type SearchPublicVideosQuery = z.infer<typeof searchPublicVideosSchema>['query'];
export type SignVideoMultipartUploadPartsBody = z.infer<
  typeof signVideoMultipartUploadPartsSchema
>['body'];
export type CompleteVideoMultipartUploadBody = z.infer<
  typeof completeVideoMultipartUploadSchema
>['body'];
