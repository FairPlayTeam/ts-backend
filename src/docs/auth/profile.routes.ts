import type { RouteDoc } from '../registry.js';
import {
  authRequiredErrorResponse,
  badRequestErrorResponse,
  commonErrorResponses,
  jsonRequest,
  jsonResponse,
  serviceUnavailableErrorResponse,
} from './shared.js';
import {
  currentUserResponseSchema,
  updateProfileBodySchema,
  updateProfileResponseSchema,
} from '../../controllers/auth.schemas.js';
import { UPDATE_PROFILE_SUCCESS_MESSAGE } from '../../services/auth/auth.messages.js';

export const profileRouteDocs = [
  {
    method: 'get',
    path: '/auth/me',
    summary: 'Get current user profile data',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Current user profile', currentUserResponseSchema),

      ...authRequiredErrorResponse,

      ...serviceUnavailableErrorResponse,

      ...commonErrorResponses,
    },
  },
  {
    method: 'patch',
    path: '/auth/me',
    summary: 'Update current user profile',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: jsonRequest(updateProfileBodySchema),
    responses: {
      200: jsonResponse(UPDATE_PROFILE_SUCCESS_MESSAGE, updateProfileResponseSchema),

      ...badRequestErrorResponse,

      ...authRequiredErrorResponse,

      ...commonErrorResponses,
    },
  },
] satisfies RouteDoc[];
