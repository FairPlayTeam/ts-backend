import {
  completeVideoMultipartUploadBodySchema,
  createVideoBodySchema,
  createVideoResponseSchema,
  myVideosQuerySchema,
  myVideosResponseSchema,
  signedVideoUploadPartsResponseSchema,
  signVideoMultipartUploadPartsBodySchema,
  videoMultipartUploadSessionParamsSchema,
  videoParamsSchema,
  videoUploadSessionResponseSchema,
} from '../controllers/videos.schemas.js';
import { jsonRequest, jsonResponse } from './openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from './registry.js';

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
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
  503: jsonResponse('Object storage unavailable', ApiErrorSchema),
};

export const routeDocs = [
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
    summary: 'Abort a multipart video upload',
    tags: ['Videos'],
    security: [{ bearerAuth: [] }],
    request: {
      params: videoMultipartUploadSessionParamsSchema,
    },
    responses: {
      200: jsonResponse('Multipart upload session aborted', videoUploadSessionResponseSchema),
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
