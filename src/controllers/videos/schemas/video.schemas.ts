import { z } from '../../../docs/zod.js';

const VIDEO_TITLE_MAX_LENGTH = 120;
const VIDEO_DESCRIPTION_MAX_LENGTH = 5_000;
const VIDEO_LICENSE_MAX_LENGTH = 64;
const VIDEO_TAG_MAX_LENGTH = 40;
const VIDEO_TAGS_MAX_COUNT = 20;

export const MY_VIDEOS_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorId must be provided together';

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

const partNumberSchema = z.number().int().min(1).max(10_000).openapi({ example: 1 });

const videoVisibilitySchema = z.enum(['public', 'unlisted']);

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
      .openapi({ example: 'FairPlay launch recap' }),
    description: z
      .string()
      .trim()
      .max(
        VIDEO_DESCRIPTION_MAX_LENGTH,
        `Video description must be at most ${VIDEO_DESCRIPTION_MAX_LENGTH} characters`,
      )
      .nullable()
      .optional()
      .openapi({ example: 'A short behind-the-scenes video.' }),
    tags: videoTagsSchema.openapi({ example: ['fairplay', 'launch'] }),
    license: z
      .string()
      .trim()
      .min(1, 'Video license must not be empty')
      .max(
        VIDEO_LICENSE_MAX_LENGTH,
        `Video license must be at most ${VIDEO_LICENSE_MAX_LENGTH} characters`,
      )
      .default('all_rights_reserved')
      .openapi({ example: 'all_rights_reserved' }),
    visibility: videoVisibilitySchema.default('unlisted').openapi({ example: 'public' }),
    allowComments: z.boolean().default(true).openapi({ example: true }),
  })
  .strict()
  .openapi('CreateVideoRequest');

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

export const initVideoMultipartUploadSchema = z.object({
  params: videoParamsSchema,
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

const videoUploadPartResponseSchema = z.object({
  partNumber: z.number().int().positive().openapi({ example: 1 }),
  etag: z.string().openapi({ example: '"abc123"' }),
  sizeBytes: z.number().int().positive().nullable().openapi({ example: null }),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const videoResponseBodySchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  publicId: z.string().openapi({ example: 'AbCdEf123_' }),
  ownerId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  title: z.string().openapi({ example: 'FairPlay launch recap' }),
  description: z.string().nullable().openapi({ example: 'A short behind-the-scenes video.' }),
  tags: z.array(z.string()).openapi({ example: ['fairplay', 'launch'] }),
  license: z.string().openapi({ example: 'all_rights_reserved' }),
  visibility: videoVisibilitySchema.openapi({ example: 'unlisted' }),
  allowComments: z.boolean().openapi({ example: true }),
  processingStatus: z
    .enum(['draft', 'uploading', 'queued', 'processing', 'ready', 'failed'])
    .openapi({
      example: 'draft',
    }),
  moderationStatus: z.enum(['pending', 'approved', 'rejected']).openapi({ example: 'pending' }),
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

const videoUploadSessionResponseBodySchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  videoId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  status: z.enum(['initiated', 'uploading', 'completed', 'aborted', 'expired']).openapi({
    example: 'initiated',
  }),
  bucket: z.string().openapi({ example: 'videos' }),
  objectKey: z.string().openapi({
    example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f/video-uuid/original.mp4',
  }),
  uploadId: z.string().openapi({ example: 'multipart-upload-id' }),
  partSizeBytes: z.number().int().positive().openapi({ example: 67_108_864 }),
  partCount: z.number().int().nonnegative().nullable().openapi({ example: null }),
  expiresAt: z.string().datetime().openapi({ example: '2026-01-02T00:00:00.000Z' }),
  completedAt: z.string().datetime().nullable().openapi({ example: null }),
  abortedAt: z.string().datetime().nullable().openapi({ example: null }),
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
            'http://localhost:9000/videos/user-id/video-id/original.mp4?partNumber=1&uploadId=...',
        }),
      }),
    ),
  })
  .openapi('SignedVideoUploadPartsResponse');

export const createVideoSchema = z.object({
  body: createVideoBodySchema,
});

export const listMyVideosSchema = z.object({
  query: myVideosQuerySchema,
});

export type VideoParams = z.infer<typeof initVideoMultipartUploadSchema>['params'];
export type VideoMultipartUploadSessionParams = z.infer<
  typeof getVideoMultipartUploadSessionSchema
>['params'];
export type CreateVideoBody = z.infer<typeof createVideoSchema>['body'];
export type ListMyVideosQuery = z.infer<typeof listMyVideosSchema>['query'];
export type SignVideoMultipartUploadPartsBody = z.infer<
  typeof signVideoMultipartUploadPartsSchema
>['body'];
export type CompleteVideoMultipartUploadBody = z.infer<
  typeof completeVideoMultipartUploadSchema
>['body'];
