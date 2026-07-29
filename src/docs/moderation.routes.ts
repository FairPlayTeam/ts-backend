import {
  adminVideoParamsSchema,
  adminVideosQuerySchema,
  adminVideosResponseSchema,
  moderateAdminVideoRequestSchema,
  moderateAdminVideoResponseSchema,
} from '../controllers/admin.schemas.js';
import { INSUFFICIENT_PERMISSIONS_MESSAGE } from '../middleware/routeProtection.js';
import { jsonRequest, jsonResponse } from './openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from './registry.js';

const commonModerationVideoResponses = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
  401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),
  403: jsonResponse(INSUFFICIENT_PERMISSIONS_MESSAGE, ApiErrorSchema),
  429: jsonResponse('Too many requests', ApiErrorSchema),
  500: jsonResponse('Internal server error', ApiErrorSchema),
};

export const routeDocs = [
  {
    method: 'get',
    path: '/moderation/videos',
    summary: 'List videos awaiting or having received moderation',
    tags: ['Moderation'],
    security: [{ bearerAuth: [] }],
    request: {
      query: adminVideosQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated moderation video list', adminVideosResponseSchema),
      ...commonModerationVideoResponses,
    },
  },
  {
    method: 'post',
    path: '/moderation/videos/{videoId}/moderation',
    summary: 'Approve or reject a video',
    tags: ['Moderation'],
    security: [{ bearerAuth: [] }],
    request: {
      params: adminVideoParamsSchema,
      ...jsonRequest(moderateAdminVideoRequestSchema),
    },
    responses: {
      200: jsonResponse('Moderation decision applied', moderateAdminVideoResponseSchema),
      ...commonModerationVideoResponses,
      404: jsonResponse('Video not found', ApiErrorSchema),
    },
  },
] satisfies RouteDoc[];
