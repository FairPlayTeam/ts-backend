import {
  jsonRequest,
  jsonResponse,
  multipartFormDataRequest,
} from '../../../docs/openapi.helpers.js';
import {
  ApiErrorSchema,
  ApiOrValidationErrorSchema,
  type RouteDoc,
} from '../../../docs/registry.js';
import {
  completeVideoMultipartUploadBodySchema,
  initVideoMultipartUploadBodySchema,
  signedVideoUploadPartsResponseSchema,
  signVideoMultipartUploadPartsBodySchema,
  uploadVideoSourceThumbnailBodySchema,
  uploadVideoSourceThumbnailResponseSchema,
  videoMultipartUploadSessionParamsSchema,
  videoParamsSchema,
  videoUploadSessionResponseSchema,
} from './schemas.js';

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

export const routeDocs = [
  {
    method: 'post',
    path: '/videos/{publicId}/upload/multipart/init',
    operationId: 'initializeVideoMultipartUpload',
    summary: 'Initialize a multipart video upload',
    description:
      'Reserves capacity for 15 minutes without verified progress (configurable, minimum 60 seconds), with a 24-hour absolute limit. Admission also limits each account to two admitted reservations per rolling hour by default; aborting or deleting a video does not refund this budget.',
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
    path: '/videos/{publicId}/upload/multipart/{uploadSessionId}/parts/sign',
    operationId: 'signVideoMultipartUploadParts',
    summary: 'Sign multipart video upload parts',
    description:
      'Call after completed part transfers, even when URLs were signed in a batch. Backend ListParts checks use half the time remaining, clamped to 5–30 seconds, persisted per session. Budget at least 5 seconds for a suppressed check to become eligible again, plus network, S3 and SQL processing time, before expiresAt; retry with that margin if the returned deadline has not advanced. A 200 with unchanged expiresAt does not acknowledge renewal. Parts arriving during the last 5 seconds have no guaranteed renewal. Only newly verified bytes in correctly sized parts renew the reservation, up to its absolute deadline. Rewriting a part or polling without progress does not renew it. Delayed observations cannot revive an expired session. Each URL expires no later than the deadline used when signing it. An old cooldown already in progress during rollout can still last 30 seconds.',
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
    path: '/videos/{publicId}/upload/multipart/{uploadSessionId}/thumbnail',
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
    path: '/videos/{publicId}/upload/multipart/{uploadSessionId}/complete',
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
    path: '/videos/{publicId}/upload/multipart/{uploadSessionId}/abort',
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
    path: '/videos/{publicId}/upload/multipart/{uploadSessionId}',
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
