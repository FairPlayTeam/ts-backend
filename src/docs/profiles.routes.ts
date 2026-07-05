import {
  followPublicProfileResponseSchema,
  publicProfileParamsSchema,
  publicProfileResponseSchema,
  unfollowPublicProfileResponseSchema,
} from '../controllers/profiles.schemas.js';
import { jsonResponse } from './openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from './registry.js';

export const routeDocs = [
  {
    method: 'get',
    path: '/profiles/{username}',
    summary: 'Get a public user profile',
    tags: ['Profiles'],
    request: {
      params: publicProfileParamsSchema,
    },
    responses: {
      200: jsonResponse('Public user profile', publicProfileResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      404: jsonResponse('Public profile not found', ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),

      503: jsonResponse('Object storage unavailable', ApiErrorSchema),
    },
  },
  {
    method: 'post',
    path: '/profiles/{username}/follow',
    summary: 'Follow a public user profile',
    tags: ['Profiles'],
    security: [{ bearerAuth: [] }],
    request: {
      params: publicProfileParamsSchema,
    },
    responses: {
      200: jsonResponse('Public user profile followed', followPublicProfileResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      401: jsonResponse('Authentication required', ApiErrorSchema),

      404: jsonResponse('Public profile not found', ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),

      503: jsonResponse('Object storage unavailable', ApiErrorSchema),
    },
  },
  {
    method: 'delete',
    path: '/profiles/{username}/follow',
    summary: 'Unfollow a public user profile',
    tags: ['Profiles'],
    security: [{ bearerAuth: [] }],
    request: {
      params: publicProfileParamsSchema,
    },
    responses: {
      200: jsonResponse('Public user profile unfollowed', unfollowPublicProfileResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      401: jsonResponse('Authentication required', ApiErrorSchema),

      404: jsonResponse('Public profile not found', ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),

      503: jsonResponse('Object storage unavailable', ApiErrorSchema),
    },
  },
] satisfies RouteDoc[];
