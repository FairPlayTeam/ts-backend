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
    summary: 'Create video metadata',
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
    summary: 'List root comment threads for a readable video',
    tags: ['Videos'],
    security: [],
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
    summary: 'List replies in a one-level video comment thread',
    tags: ['Videos'],
    security: [],
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
    summary: "Soft-delete the current user's own video comment",
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
    method: 'post',
    path: '/videos/{videoId}/upload/multipart/init',
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
