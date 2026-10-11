import {
  completeVideoMultipartUploadBodySchema,
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
  rateVideoBodySchema,
  signedVideoUploadPartsResponseSchema,
  signVideoMultipartUploadPartsBodySchema,
  uploadVideoSourceThumbnailBodySchema,
  uploadVideoSourceThumbnailResponseSchema,
  videoHlsRenditionParamsSchema,
  videoHlsSegmentParamsSchema,
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

const deleteVideoResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Authentication required', ApiErrorSchema),
  404: jsonResponse('Video not found or not owned by the current user', ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Video deletion temporarily unavailable', ApiErrorSchema),
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
    summary: 'Search public videos and creators',
    tags: ['Videos'],
    security: [],
    request: {
      query: publicVideoSearchQuerySchema,
    },
    responses: {
      200: jsonResponse(
        'Paginated public video results with bounded creator matches',
        publicVideoSearchResponseSchema,
      ),
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
    method: 'delete',
    path: '/videos/{publicId}',
    operationId: 'deleteOwnedVideo',
    summary: 'Permanently delete a video owned by the current user',
    description:
      'Deletes the database video immediately and durably schedules every associated external resource for absence. Moderator and administrator roles grant no ownership override on this route.',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: publicVideoIdParamsSchema,
    },
    responses: {
      204: {
        description: 'Video deleted and external cleanup scheduled',
      },
      ...deleteVideoResponses,
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
    path: '/videos/{publicId}/hls/{generationToken}/{quality}/index.m3u8',
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
    path: '/videos/{publicId}/hls/{generationToken}/{quality}/segments/{segment}',
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
      'Creates draft video metadata as unlisted. Visibility is controlled by moderation and cannot be selected by the uploader. The optional allowComments preference defaults to true and cannot be changed through this API version after creation.',
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
