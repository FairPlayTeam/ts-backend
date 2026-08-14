import {
  completeVideoMultipartUploadBodySchema,
  createVideoCommentBodySchema,
  createVideoCommentReplyBodySchema,
  createVideoBodySchema,
  createVideoResponseSchema,
  publicVideoDetailResponseSchema,
  initVideoMultipartUploadBodySchema,
  myVideosQuerySchema,
  myVideosResponseSchema,
  publicVideoIdParamsSchema,
  publicVideoSearchQuerySchema,
  publicVideoSearchResponseSchema,
  publicVideosQuerySchema,
  publicVideosResponseSchema,
  videoCommentRepliesResponseSchema,
  videoCommentsQuerySchema,
  videoCommentsResponseSchema,
  rateVideoBodySchema,
  signedVideoUploadPartsResponseSchema,
  signVideoMultipartUploadPartsBodySchema,
  uploadVideoSourceThumbnailBodySchema,
  uploadVideoSourceThumbnailResponseSchema,
  videoHlsRenditionParamsSchema,
  videoHlsSegmentParamsSchema,
  videoCommentReplyParamsSchema,
  videoCommentParamsSchema,
  videoCommentResponseSchema,
  videoMultipartUploadSessionParamsSchema,
  videoParamsSchema,
  videoRatingAggregateResponseSchema,
  videoRatingParamsSchema,
  videoRatingResponseSchema,
  videoUploadSessionResponseSchema,
} from '../controllers/videos.schemas.js';
import { jsonRequest, jsonResponse, multipartFormDataRequest } from './openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from './registry.js';
import { z } from './zod.js';

const videoCreateResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const videoListResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const publicVideoSearchResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const publicVideoDetailResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  404: jsonResponse('Video not found or inaccessible', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const videoUploadResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  404: jsonResponse('Video or upload session not found', ApiErrorSchema),
  409: jsonResponse('Upload session conflict', ApiErrorSchema),
  413: jsonResponse('Declared upload is too large', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Object storage unavailable', ApiErrorSchema),
};

const publicVideoRatingResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  404: jsonResponse('Video not found or inaccessible', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const authenticatedVideoRatingResponses = {
  ...publicVideoRatingResponses,
  401: jsonResponse('Authentication required', ApiErrorSchema),
};

const putVideoRatingResponses = {
  ...authenticatedVideoRatingResponses,
  403: jsonResponse('Video owners cannot rate their own videos', ApiErrorSchema),
  503: jsonResponse('Video rating temporarily unavailable', ApiErrorSchema),
};

const createVideoCommentResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  404: jsonResponse('Video or comment not found or inaccessible', ApiErrorSchema),
  409: jsonResponse('Comments are disabled', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Comment creation temporarily unavailable', ApiErrorSchema),
};

const publicVideoCommentListResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  404: jsonResponse('Video or comment not found or inaccessible', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const deleteVideoCommentResponses = {
  ...publicVideoCommentListResponses,
  401: jsonResponse('Authentication required', ApiErrorSchema),
  503: jsonResponse('Comment deletion temporarily unavailable', ApiErrorSchema),
};

const putVideoCommentLikeResponses = {
  ...deleteVideoCommentResponses,
  409: jsonResponse('Comments are disabled', ApiErrorSchema),
  503: jsonResponse('Comment like mutation temporarily unavailable', ApiErrorSchema),
};

const deleteVideoCommentLikeResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Comment like mutation temporarily unavailable', ApiErrorSchema),
};

const hlsPlaylistResponse = (description: string) => ({
  description,
  content: {
    'application/vnd.apple.mpegurl': {
      schema: z.string(),
    },
  },
});

const videoHlsResponses = {
  404: jsonResponse('Public HLS resource not found', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Object storage unavailable', ApiErrorSchema),
};

export const routeDocs = [
  {
    method: 'get',
    path: '/videos',
    operationId: 'listPublicVideos',
    summary: 'List the public video feed',
    tags: ['Videos'],
    security: [],
    request: {
      query: publicVideosQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated public video feed', publicVideosResponseSchema),
      ...publicVideoSearchResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/search',
    operationId: 'searchPublicVideos',
    summary: 'Search public videos',
    tags: ['Videos'],
    security: [],
    request: {
      query: publicVideoSearchQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated public video search results', publicVideoSearchResponseSchema),
      ...publicVideoSearchResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}',
    operationId: 'getPublicVideo',
    summary: 'Get a playable public video detail',
    tags: ['Videos'],
    security: [{}, { bearerAuth: [] }],
    request: {
      params: publicVideoIdParamsSchema,
    },
    responses: {
      200: jsonResponse('Playable public video detail', publicVideoDetailResponseSchema),
      ...publicVideoDetailResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}/thumbnail',
    operationId: 'getVideoThumbnail',
    summary: 'Redirect to the active public video thumbnail',
    tags: ['Videos'],
    security: [],
    request: {
      params: publicVideoIdParamsSchema,
    },
    responses: {
      307: {
        description: 'Temporary redirect to a fresh signed object-storage URL',
      },
      ...videoHlsResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}/hls/master.m3u8',
    operationId: 'getVideoHlsMasterPlaylist',
    summary: 'Get the public HLS master playlist',
    tags: ['Videos'],
    security: [],
    request: {
      params: publicVideoIdParamsSchema,
    },
    responses: {
      200: hlsPlaylistResponse('Rewritten HLS master playlist'),
      ...videoHlsResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}/hls/{generationId}/{quality}/index.m3u8',
    operationId: 'getVideoHlsRenditionPlaylist',
    summary: 'Get an immutable public HLS rendition playlist',
    tags: ['Videos'],
    security: [],
    request: {
      params: videoHlsRenditionParamsSchema,
    },
    responses: {
      200: hlsPlaylistResponse('Rewritten HLS rendition playlist'),
      ...videoHlsResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}/hls/{generationId}/{quality}/segments/{segment}',
    operationId: 'getVideoHlsSegment',
    summary: 'Redirect to a signed immutable HLS segment',
    tags: ['Videos'],
    security: [],
    request: {
      params: videoHlsSegmentParamsSchema,
    },
    responses: {
      307: {
        description: 'Temporary redirect to a fresh signed object-storage URL',
      },
      ...videoHlsResponses,
    },
  },
  {
    method: 'post',
    path: '/videos',
    operationId: 'createVideo',
    summary: 'Create video metadata',
    description:
      'Creates draft video metadata. The optional allowComments preference defaults to true and cannot be changed through this API version after creation.',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: jsonRequest(createVideoBodySchema),
    responses: {
      201: jsonResponse('Video metadata created', createVideoResponseSchema),
      ...videoCreateResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/me',
    operationId: 'listCurrentUserVideos',
    summary: 'List videos owned by the current user',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      query: myVideosQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated owner video list', myVideosResponseSchema),
      ...videoListResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}/rating',
    operationId: 'getVideoRating',
    summary: 'Get the public rating aggregate for a video',
    tags: ['Videos'],
    security: [],
    request: {
      params: videoRatingParamsSchema,
    },
    responses: {
      200: jsonResponse('Video rating aggregate', videoRatingAggregateResponseSchema),
      ...publicVideoRatingResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{publicId}/rating/me',
    operationId: 'getCurrentUserVideoRating',
    summary: "Get the current user's rating for a video",
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoRatingParamsSchema,
    },
    responses: {
      200: jsonResponse(
        'Video rating aggregate and current user rating',
        videoRatingResponseSchema,
      ),
      ...authenticatedVideoRatingResponses,
    },
  },
  {
    method: 'put',
    path: '/videos/{publicId}/rating',
    operationId: 'rateVideo',
    summary: 'Create or update the current user rating for a video',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoRatingParamsSchema,
      ...jsonRequest(rateVideoBodySchema),
    },
    responses: {
      200: jsonResponse('Updated video rating aggregate', videoRatingResponseSchema),
      ...putVideoRatingResponses,
    },
  },
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
      query: videoCommentsQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated root video comments', videoCommentsResponseSchema),
      ...publicVideoCommentListResponses,
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
      params: videoCommentReplyParamsSchema,
      query: videoCommentsQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated video comment replies', videoCommentRepliesResponseSchema),
      ...publicVideoCommentListResponses,
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
      ...jsonRequest(createVideoCommentBodySchema),
    },
    responses: {
      201: jsonResponse('Created video comment', videoCommentResponseSchema),
      ...createVideoCommentResponses,
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
      params: videoCommentReplyParamsSchema,
      ...jsonRequest(createVideoCommentReplyBodySchema),
    },
    responses: {
      201: jsonResponse('Created video comment reply', videoCommentResponseSchema),
      ...createVideoCommentResponses,
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
      params: videoCommentParamsSchema,
    },
    responses: {
      204: {
        description: 'Comment deleted or already deleted',
      },
      ...deleteVideoCommentResponses,
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
      params: videoCommentParamsSchema,
    },
    responses: {
      204: {
        description: 'The comment is liked by the current user',
      },
      ...putVideoCommentLikeResponses,
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
      params: videoCommentParamsSchema,
    },
    responses: {
      204: {
        description: "The current user's like was removed or was already absent",
      },
      ...deleteVideoCommentLikeResponses,
    },
  },
  {
    method: 'post',
    path: '/videos/{videoId}/upload/multipart/init',
    operationId: 'initializeVideoMultipartUpload',
    summary: 'Initialize a multipart video upload',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoParamsSchema,
      ...jsonRequest(initVideoMultipartUploadBodySchema),
    },
    responses: {
      201: jsonResponse('Multipart upload session initialized', videoUploadSessionResponseSchema),
      ...videoUploadResponses,
    },
  },
  {
    method: 'post',
    path: '/videos/{videoId}/upload/multipart/{uploadSessionId}/parts/sign',
    operationId: 'signVideoMultipartUploadParts',
    summary: 'Sign multipart video upload parts',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoMultipartUploadSessionParamsSchema,
      ...jsonRequest(signVideoMultipartUploadPartsBodySchema),
    },
    responses: {
      200: jsonResponse('Signed multipart upload part URLs', signedVideoUploadPartsResponseSchema),
      ...videoUploadResponses,
    },
  },
  {
    method: 'put',
    path: '/videos/{videoId}/upload/multipart/{uploadSessionId}/thumbnail',
    operationId: 'uploadVideoSourceThumbnail',
    summary: 'Upload or replace a source-bound video thumbnail',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoMultipartUploadSessionParamsSchema,
      ...multipartFormDataRequest(uploadVideoSourceThumbnailBodySchema),
    },
    responses: {
      200: jsonResponse(
        'Normalized source thumbnail confirmed',
        uploadVideoSourceThumbnailResponseSchema,
      ),
      ...videoUploadResponses,
    },
  },
  {
    method: 'post',
    path: '/videos/{videoId}/upload/multipart/{uploadSessionId}/complete',
    operationId: 'completeVideoMultipartUpload',
    summary: 'Complete a multipart video upload',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoMultipartUploadSessionParamsSchema,
      ...jsonRequest(completeVideoMultipartUploadBodySchema),
    },
    responses: {
      200: jsonResponse('Multipart upload session completed', videoUploadSessionResponseSchema),
      ...videoUploadResponses,
    },
  },
  {
    method: 'post',
    path: '/videos/{videoId}/upload/multipart/{uploadSessionId}/abort',
    operationId: 'abortVideoMultipartUpload',
    summary: 'Schedule a multipart video upload for durable abort',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoMultipartUploadSessionParamsSchema,
    },
    responses: {
      200: jsonResponse('Multipart upload abort scheduled', videoUploadSessionResponseSchema),
      ...videoUploadResponses,
    },
  },
  {
    method: 'get',
    path: '/videos/{videoId}/upload/multipart/{uploadSessionId}',
    operationId: 'getVideoMultipartUpload',
    summary: 'Get a multipart video upload session',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoMultipartUploadSessionParamsSchema,
    },
    responses: {
      200: jsonResponse('Multipart upload session', videoUploadSessionResponseSchema),
      ...videoUploadResponses,
    },
  },
] satisfies RouteDoc[];
