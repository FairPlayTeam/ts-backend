import { VIDEO_COMMENT_MAX_LENGTH } from '../../../config/constants.js';
import { z } from '../../../docs/zod.js';
import { publicProfileIdentityResponseSchema } from '../../../controllers/shared/profile.schemas.js';
import { publicVideoIdParamsSchema } from '../../../controllers/videos/schemas/video.schemas.js';

export const VIDEO_COMMENT_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorId must be provided together';

const commentIdSchema = z.string().uuid('Comment id must be a valid UUID').openapi({
  example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
});

export const commentReplyParamsSchema = publicVideoIdParamsSchema
  .extend({
    rootCommentId: commentIdSchema,
  })
  .openapi('VideoCommentReplyParams');

export const commentParamsSchema = publicVideoIdParamsSchema
  .extend({
    commentId: commentIdSchema,
  })
  .openapi('VideoCommentParams');

const commentContentSchema = z
  .string()
  .trim()
  .min(1, 'Comment content must not be empty')
  .max(
    VIDEO_COMMENT_MAX_LENGTH,
    `Comment content must be at most ${VIDEO_COMMENT_MAX_LENGTH} characters`,
  )
  .refine((content) => !content.includes('\u0000'), {
    message: 'Comment content must not contain NUL characters',
  })
  .refine(
    (content) =>
      content.replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Control}]/gu, '').length >
      0,
    {
      message: 'Comment content must contain visible characters',
    },
  );

export const createCommentBodySchema = z
  .object({
    content: commentContentSchema.openapi({ example: 'This is the first FairPlay video.' }),
  })
  .strict()
  .openapi('CreateVideoCommentRequest');

export const createReplyBodySchema = createCommentBodySchema
  .extend({
    replyingToCommentId: commentIdSchema.optional(),
  })
  .strict()
  .openapi('CreateVideoCommentReplyRequest');

export const commentsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    cursorCreatedAt: z.string().datetime().optional().openapi({
      example: '2026-01-01T00:00:00.000Z',
    }),
    cursorId: commentIdSchema.optional(),
  })
  .strict()
  .refine((query) => (query.cursorCreatedAt === undefined) === (query.cursorId === undefined), {
    message: VIDEO_COMMENT_CURSOR_PAIR_MESSAGE,
  })
  .openapi('VideoCommentsQuery');

const commentResponseBodySchema = z.object({
  id: commentIdSchema,
  content: z.string().openapi({ example: 'This is the first FairPlay video.' }),
  isDeleted: z.literal(false),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  rootCommentId: commentIdSchema.nullable(),
  likeCount: z.number().int().nonnegative().openapi({ example: 4 }),
  viewerHasLiked: z.boolean().openapi({ example: true }),
  replyingTo: z
    .object({
      commentId: commentIdSchema,
      username: z.string().openapi({ example: 'jawed' }),
    })
    .nullable(),
  author: publicProfileIdentityResponseSchema,
});

export const commentResponseSchema = z
  .object({
    comment: commentResponseBodySchema,
  })
  .openapi('VideoCommentResponse');

const commentReplyCountSchema = z.number().int().nonnegative().openapi({ example: 3 });

const activeCommentRootResponseSchema = commentResponseBodySchema.extend({
  rootCommentId: z.null(),
  replyingTo: z.null(),
  replyCount: commentReplyCountSchema,
});

const deletedCommentRootResponseSchema = z.object({
  id: commentIdSchema,
  content: z.null(),
  isDeleted: z.literal(true),
  createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  rootCommentId: z.null(),
  likeCount: z.literal(0),
  viewerHasLiked: z.literal(false),
  replyingTo: z.null(),
  author: z.null(),
  replyCount: commentReplyCountSchema,
});

const commentCursorResponseSchema = z
  .object({
    id: commentIdSchema,
    createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  })
  .nullable();

export const commentsResponseSchema = z
  .object({
    comments: z.array(z.union([activeCommentRootResponseSchema, deletedCommentRootResponseSchema])),
    total: z.number().int().nonnegative().openapi({
      description:
        'Number of visible root threads, including deleted-root placeholders that still have active replies. This differs from video detail commentCount, which counts every active root and reply.',
    }),
    nextCursor: commentCursorResponseSchema,
  })
  .openapi('VideoCommentsResponse');

export const commentRepliesResponseSchema = z
  .object({
    replies: z.array(
      commentResponseBodySchema.extend({
        rootCommentId: commentIdSchema,
      }),
    ),
    total: z.number().int().nonnegative(),
    nextCursor: commentCursorResponseSchema,
  })
  .openapi('VideoCommentRepliesResponse');

export const createCommentSchema = z.object({
  params: publicVideoIdParamsSchema,
  body: createCommentBodySchema,
});

export const createReplySchema = z.object({
  params: commentReplyParamsSchema,
  body: createReplyBodySchema,
});

export const listCommentsSchema = z.object({
  params: publicVideoIdParamsSchema,
  query: commentsQuerySchema,
});

export const listRepliesSchema = z.object({
  params: commentReplyParamsSchema,
  query: commentsQuerySchema,
});

export const deleteCommentSchema = z.object({
  params: commentParamsSchema,
});

export const mutateCommentLikeSchema = deleteCommentSchema;

export type PublicVideoIdParams = z.infer<typeof publicVideoIdParamsSchema>;
export type CommentReplyParams = z.infer<typeof commentReplyParamsSchema>;
export type CommentParams = z.infer<typeof commentParamsSchema>;
export type CreateCommentBody = z.infer<typeof createCommentSchema>['body'];
export type CreateReplyBody = z.infer<typeof createReplySchema>['body'];
export type ListCommentsQuery = z.infer<typeof listCommentsSchema>['query'];
