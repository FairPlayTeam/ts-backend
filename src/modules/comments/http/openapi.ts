import { jsonRequest, jsonResponse } from '../../../docs/openapi.helpers.js';
import {
  ApiErrorSchema,
  ApiOrValidationErrorSchema,
  type RouteDoc,
} from '../../../docs/registry.js';
import { publicVideoIdParamsSchema } from '../../../controllers/videos/schemas/video.schemas.js';
import {
  commentParamsSchema,
  commentRepliesResponseSchema,
  commentReplyParamsSchema,
  commentResponseSchema,
  commentsQuerySchema,
  commentsResponseSchema,
  createCommentBodySchema,
  createReplyBodySchema,
} from './schemas.js';

const createCommentResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  404: jsonResponse('Video or comment not found or inaccessible', ApiErrorSchema),
  409: jsonResponse('Comments are disabled', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Comment creation temporarily unavailable', ApiErrorSchema),
};

const publicCommentListResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  404: jsonResponse('Video or comment not found or inaccessible', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const deleteCommentResponses = {
  ...publicCommentListResponses,
  401: jsonResponse('Authentication required', ApiErrorSchema),
  503: jsonResponse('Comment deletion temporarily unavailable', ApiErrorSchema),
};

const putCommentLikeResponses = {
  ...deleteCommentResponses,
  409: jsonResponse('Comments are disabled', ApiErrorSchema),
  503: jsonResponse('Comment like mutation temporarily unavailable', ApiErrorSchema),
};

const deleteCommentLikeResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Comment like mutation temporarily unavailable', ApiErrorSchema),
};

export const routeDocs = [
  {
    method: 'get',
    path: '/videos/{publicId}/comments',
    operationId: 'listVideoComments',
    summary: 'List public comment threads for a video',
    description:
      'Public endpoint. Authentication is optional and is used only to calculate viewerHasLiked for the current viewer; anonymous viewers can read comments and receive viewerHasLiked=false.',
    tags: ['Videos'],
    security: [{}, { bearerAuth: [] }],
    request: {
      params: publicVideoIdParamsSchema,
      query: commentsQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated root video comments', commentsResponseSchema),
      ...publicCommentListResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}/comments/{rootCommentId}/replies',
    operationId: 'listVideoCommentReplies',
    summary: 'List public replies to a video comment',
    description:
      'Public endpoint. Authentication is optional and is used only to calculate viewerHasLiked for the current viewer; anonymous viewers can read replies and receive viewerHasLiked=false.',
    tags: ['Videos'],
    security: [{}, { bearerAuth: [] }],
    request: {
      params: commentReplyParamsSchema,
      query: commentsQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated video comment replies', commentRepliesResponseSchema),
      ...publicCommentListResponses,
    },
  },
  {
    method: 'post',
    path: '/videos/{publicId}/comments',
    operationId: 'createVideoComment',
    summary: 'Create a root comment under a video',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: publicVideoIdParamsSchema,
      ...jsonRequest(createCommentBodySchema),
    },
    responses: {
      201: jsonResponse('Created video comment', commentResponseSchema),
      ...createCommentResponses,
    },
  },
  {
    method: 'post',
    path: '/videos/{publicId}/comments/{rootCommentId}/replies',
    operationId: 'createVideoCommentReply',
    summary: 'Reply in a one-level video comment thread',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: commentReplyParamsSchema,
      ...jsonRequest(createReplyBodySchema),
    },
    responses: {
      201: jsonResponse('Created video comment reply', commentResponseSchema),
      ...createCommentResponses,
    },
  },
  {
    method: 'delete',
    path: '/videos/{publicId}/comments/{commentId}',
    operationId: 'deleteVideoComment',
    summary: 'Soft-delete a video comment when permitted',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: commentParamsSchema,
    },
    responses: {
      204: {
        description: 'Comment deleted or already deleted',
      },
      ...deleteCommentResponses,
    },
  },
  {
    method: 'put',
    path: '/videos/{publicId}/comments/{commentId}/like',
    operationId: 'likeVideoComment',
    summary: 'Like a video comment',
    description:
      "Adds the current user's like to an active comment. The operation is idempotent: liking an already liked comment succeeds without changing its like count.",
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: commentParamsSchema,
    },
    responses: {
      204: {
        description: 'The comment is liked by the current user',
      },
      ...putCommentLikeResponses,
    },
  },
  {
    method: 'delete',
    path: '/videos/{publicId}/comments/{commentId}/like',
    operationId: 'unlikeVideoComment',
    summary: 'Unlike a video comment',
    description:
      "Removes the current user's like from a comment. The operation is idempotent and remains available when the video is no longer eligible for engagement or the comment has been deleted.",
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: commentParamsSchema,
    },
    responses: {
      204: {
        description: "The current user's like was removed or was already absent",
      },
      ...deleteCommentLikeResponses,
    },
  },
] satisfies RouteDoc[];
