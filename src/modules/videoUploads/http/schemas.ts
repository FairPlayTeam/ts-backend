import { z } from '../../../docs/zod.js';
import { VIDEO_PUBLIC_ID_PATTERN } from '../../videos/shared/publicId.js';

const partNumberSchema = z.number().int().min(1).max(10_000).openapi({ example: 1 });

export const videoParamsSchema = z
  .object({
    publicId: z.string().regex(VIDEO_PUBLIC_ID_PATTERN, 'Public video id must be valid').openapi({
      description: 'Public video identifier; internal video UUIDs are not accepted.',
      example: 'AbCdEf123_',
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

const distinctPartNumbers = (partNumbers: readonly number[]): boolean =>
  new Set(partNumbers).size === partNumbers.length;

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

const videoUploadSessionResponseBodySchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  publicId: z.string().regex(VIDEO_PUBLIC_ID_PATTERN).openapi({ example: 'AbCdEf123_' }),
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
    .openapi({ example: 'initiated' }),
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
  .object({ uploadSession: videoUploadSessionResponseBodySchema })
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
          example: 'https://storage.example.com/presigned-upload-part',
        }),
      }),
    ),
  })
  .openapi('SignedVideoUploadPartsResponse');

export const uploadVideoSourceThumbnailResponseSchema = z
  .object({
    thumbnail: z.object({
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

export type VideoParams = z.infer<typeof initVideoMultipartUploadSchema>['params'];
export type VideoMultipartUploadSessionParams = z.infer<
  typeof getVideoMultipartUploadSessionSchema
>['params'];
export type InitVideoMultipartUploadBody = z.infer<typeof initVideoMultipartUploadSchema>['body'];
export type SignVideoMultipartUploadPartsBody = z.infer<
  typeof signVideoMultipartUploadPartsSchema
>['body'];
export type CompleteVideoMultipartUploadBody = z.infer<
  typeof completeVideoMultipartUploadSchema
>['body'];
