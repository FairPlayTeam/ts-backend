import {
  followPublicProfileResponseSchema,
  followingProfilesQuerySchema,
  followingProfilesResponseSchema,
  publicProfileParamsSchema,
  publicProfileResponseSchema,
  unfollowPublicProfileResponseSchema,
} from '../controllers/profiles.schemas.js';
import { jsonResponse } from './openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from './registry.js';
import { z } from './zod.js';

const profileMediaResponse = (description: string) => ({
  description,
  content: {
    'image/webp': {
      schema: z.string().openapi({ type: 'string', format: 'binary' }),
    },
  },
});

export const routeDocs = [
  {
    method: 'get',
    path: '/profiles/me/following',
    operationId: 'listCurrentUserFollowingProfiles',
    summary: 'List profiles followed by the current user',
    tags: ['Profiles'],
    security: [{ bearerAuth: [] }],
    request: {
      query: followingProfilesQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated followed profiles list', followingProfilesResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      401: jsonResponse('Authentication required', ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),
    },
  },
  {
    method: 'get',
    path: '/profiles/{username}/avatar',
    operationId: 'getProfileAvatar',
    summary: 'Proxy a user avatar through the API',
    tags: ['Profiles'],
    security: [],
    request: {
      params: publicProfileParamsSchema,
    },
    responses: {
      200: profileMediaResponse('Avatar bytes'),
      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
      404: jsonResponse('Profile media not found', ApiErrorSchema),
      429: jsonResponse('Too many requests', ApiErrorSchema),
      500: jsonResponse('Internal server error', ApiErrorSchema),
      503: jsonResponse('Object storage unavailable', ApiErrorSchema),
    },
  },
  {
    method: 'get',
    path: '/profiles/{username}/banner',
    operationId: 'getProfileBanner',
    summary: 'Proxy a user banner through the API',
    tags: ['Profiles'],
    security: [],
    request: {
      params: publicProfileParamsSchema,
    },
    responses: {
      200: profileMediaResponse('Banner bytes'),
      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
      404: jsonResponse('Profile media not found', ApiErrorSchema),
      429: jsonResponse('Too many requests', ApiErrorSchema),
      500: jsonResponse('Internal server error', ApiErrorSchema),
      503: jsonResponse('Object storage unavailable', ApiErrorSchema),
    },
  },
  {
    method: 'get',
    path: '/profiles/{username}',
    operationId: 'getPublicProfile',
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
    },
  },
  {
    method: 'post',
    path: '/profiles/{username}/follow',
    operationId: 'followPublicProfile',
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
    },
  },
  {
    method: 'delete',
    path: '/profiles/{username}/follow',
    operationId: 'unfollowPublicProfile',
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
    },
  },
] satisfies RouteDoc[];
