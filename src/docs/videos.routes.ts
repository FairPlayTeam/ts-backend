import {
  completeVideoMultipartUploadBodySchema,
  createVideoBodySchema,
  createVideoResponseSchema,
  initVideoMultipartUploadBodySchema,
  myVideosQuerySchema,
  myVideosResponseSchema,
  signedVideoUploadPartsResponseSchema,
  signVideoMultipartUploadPartsBodySchema,
  videoHlsMasterParamsSchema,
  videoHlsRenditionParamsSchema,
  videoHlsSegmentParamsSchema,
  videoMultipartUploadSessionParamsSchema,
  videoParamsSchema,
  videoUploadSessionResponseSchema,
} from '../controllers/videos.schemas.js';
import { jsonRequest, jsonResponse } from './openapi.helpers.js';
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
    path: '/videos/{publicId}/hls/master.m3u8',
    summary: 'Get the public HLS master playlist',
    tags: ['Videos'],
    security: [],
    request: {
      params: videoHlsMasterParamsSchema,
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
