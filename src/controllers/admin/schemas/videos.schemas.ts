import { z } from '../../../docs/zod.js';

export const ADMIN_VIDEOS_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorId must be provided together';

const videoModerationStatusSchema = z.enum(['pending', 'approved', 'rejected']);
const videoProcessingStatusSchema = z.enum([
  'draft',
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
]);
const videoVisibilitySchema = z.enum(['public', 'unlisted']);

export const adminVideosQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    moderationStatus: videoModerationStatusSchema.optional().openapi({ example: 'pending' }),
    processingStatus: videoProcessingStatusSchema.optional().openapi({ example: 'ready' }),
    sort: z.enum(['newest', 'oldest']).optional().openapi({
      example: 'newest',
      description: 'Sort by creation time. Defaults to newest.',
    }),
    search: z.string().trim().max(254).optional().openapi({
      example: 'launch recap',
      description: 'Reserved; currently ignored and will be shared with a future search feature.',
    }),
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
    message: ADMIN_VIDEOS_CURSOR_PAIR_MESSAGE,
  })
  .openapi('AdminVideosQuery');

export const adminVideosSchema = z.object({
  query: adminVideosQuerySchema,
});

export const adminVideoParamsSchema = z
  .object({
    videoId: z.string().uuid('Video id must be a valid UUID').openapi({
      example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    }),
  })
  .strict()
  .openapi('AdminVideoParams');

export const moderateAdminVideoRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']).openapi({ example: 'approved' }),
  })
  .strict()
  .openapi('ModerateAdminVideoRequest');

export const moderateAdminVideoSchema = z.object({
  params: adminVideoParamsSchema,
  body: moderateAdminVideoRequestSchema,
});

const nullableVideoDateTimeSchema = z.string().datetime().nullable();

const adminVideoSummaryResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  publicId: z.string().openapi({ example: 'AbCdEf123_' }),
  ownerId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  title: z.string().openapi({ example: 'FairPlay launch recap' }),
  moderationStatus: videoModerationStatusSchema.openapi({ example: 'pending' }),
  processingStatus: videoProcessingStatusSchema.openapi({ example: 'ready' }),
  visibility: videoVisibilitySchema.openapi({ example: 'unlisted' }),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  thumbnailObjectKey: z
    .string()
    .nullable()
    .openapi({ example: 'user-id/video-id/generations/generation-id/thumbnail/poster.webp' }),
  publishedAt: nullableVideoDateTimeSchema.openapi({ example: null }),
  rejectedAt: nullableVideoDateTimeSchema.openapi({ example: null }),
});

export const adminVideosResponseSchema = z
  .object({
    videos: z.array(adminVideoSummaryResponseSchema),
    total: z.number().int().nonnegative().openapi({ example: 42 }),
    nextCursor: z
      .object({
        createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
        id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
      })
      .nullable(),
  })
  .openapi('AdminVideosResponse');

export const moderateAdminVideoResponseSchema = z
  .object({
    video: adminVideoSummaryResponseSchema,
  })
  .openapi('ModerateAdminVideoResponse');

export type AdminVideosQuery = z.infer<typeof adminVideosSchema>['query'];
export type AdminVideoParams = z.infer<typeof moderateAdminVideoSchema>['params'];
export type ModerateAdminVideoBody = z.infer<typeof moderateAdminVideoSchema>['body'];
