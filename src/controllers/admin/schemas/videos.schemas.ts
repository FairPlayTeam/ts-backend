import { z } from '../../../docs/zod.js';
import {
  VIDEO_DELETION_REASON_MAX_LENGTH,
  VIDEO_REJECTION_REASON_MAX_LENGTH,
} from '../../../config/constants.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';
import { videoSearchTextSchema } from '../../shared/search.schemas.js';

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
const videoDeletionOriginSchema = z.enum(['moderator', 'admin']);

export const adminVideosQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    moderationStatus: videoModerationStatusSchema.optional().openapi({ example: 'pending' }),
    processingStatus: videoProcessingStatusSchema.optional().openapi({ example: 'ready' }),
    sort: z.enum(['newest', 'oldest']).optional().openapi({
      example: 'newest',
      description: 'Sort by creation time. Defaults to newest.',
    }),
    search: videoSearchTextSchema.optional().openapi({
      example: 'launch recap',
      description:
        'Case-insensitive literal substring search over video titles and descriptions, plus exact tag matching.',
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

const approveAdminVideoRequestSchema = z
  .object({
    decision: z.literal('approved').openapi({ example: 'approved' }),
  })
  .strict();

const rejectAdminVideoRequestSchema = z
  .object({
    decision: z.literal('rejected').openapi({ example: 'rejected' }),
    reason: z
      .string()
      .trim()
      .min(1, 'Video rejection reason is required')
      .max(
        VIDEO_REJECTION_REASON_MAX_LENGTH,
        `Video rejection reason must be at most ${VIDEO_REJECTION_REASON_MAX_LENGTH} characters`,
      )
      .refine((reason) => !reason.includes('\u0000'), {
        message: 'Video rejection reason must not contain NUL characters',
      })
      .openapi({
        example: 'The video contains content that violates the publishing guidelines.',
      }),
  })
  .strict();

export const moderateAdminVideoRequestSchema = z
  .discriminatedUnion('decision', [approveAdminVideoRequestSchema, rejectAdminVideoRequestSchema])
  .openapi('ModerateAdminVideoRequest');

export const moderateAdminVideoSchema = z.object({
  params: adminVideoParamsSchema,
  body: moderateAdminVideoRequestSchema,
});

export const requestAdminVideoDeletionRequestSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, 'Video deletion reason is required')
      .max(
        VIDEO_DELETION_REASON_MAX_LENGTH,
        `Video deletion reason must be at most ${VIDEO_DELETION_REASON_MAX_LENGTH} characters`,
      )
      .refine((reason) => !reason.includes('\u0000'), {
        message: 'Video deletion reason must not contain NUL characters',
      })
      .openapi({
        example: 'This published video violates the platform safety policy.',
      }),
  })
  .strict()
  .openapi('RequestAdminVideoDeletionRequest');

export const requestAdminVideoDeletionSchema = z.object({
  params: adminVideoParamsSchema,
  body: requestAdminVideoDeletionRequestSchema,
});

const nullableVideoDateTimeSchema = z.string().datetime().nullable();

const adminVideoSummaryResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  publicId: z.string().openapi({ example: 'AbCdEf123_' }),
  ownerId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  username: z.string().openapi({ example: 'jawed' }),
  title: z.string().openapi({ example: 'Me at the zoo' }),
  moderationStatus: videoModerationStatusSchema.openapi({ example: 'pending' }),
  processingStatus: videoProcessingStatusSchema.openapi({ example: 'ready' }),
  visibility: videoVisibilitySchema.openapi({ example: 'unlisted' }),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  thumbnailPath: relativeAssetPathSchema
    .nullable()
    .openapi({ example: '/videos/AbCdEf123_/thumbnail' }),
  publishedAt: nullableVideoDateTimeSchema.openapi({ example: null }),
  rejectedAt: nullableVideoDateTimeSchema.openapi({ example: null }),
  rejectionReason: z
    .string()
    .nullable()
    .openapi({ example: 'The video contains content that violates the publishing guidelines.' }),
  deletionRequestedAt: nullableVideoDateTimeSchema.openapi({ example: null }),
  deletionReason: z
    .string()
    .nullable()
    .openapi({ example: 'This published video violates the platform safety policy.' }),
  deletionOrigin: videoDeletionOriginSchema.nullable().openapi({ example: null }),
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

export const requestAdminVideoDeletionResponseSchema = z
  .object({
    video: adminVideoSummaryResponseSchema,
  })
  .openapi('RequestAdminVideoDeletionResponse');

export type AdminVideosQuery = z.infer<typeof adminVideosSchema>['query'];
export type AdminVideoParams = z.infer<typeof moderateAdminVideoSchema>['params'];
export type ModerateAdminVideoBody = z.infer<typeof moderateAdminVideoSchema>['body'];
export type RequestAdminVideoDeletionBody = z.infer<typeof requestAdminVideoDeletionSchema>['body'];
