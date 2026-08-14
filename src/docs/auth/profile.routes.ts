import type { RouteDoc } from '../registry.js';
import {
  authRequiredErrorResponse,
  badRequestErrorResponse,
  commonErrorResponses,
  currentUserNotFoundErrorResponse,
  jsonRequest,
  jsonResponse,
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
    operationId: 'getCurrentUser',
    summary: 'Get current user profile data',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Current user profile', currentUserResponseSchema),

      ...authRequiredErrorResponse,

      ...currentUserNotFoundErrorResponse,

      ...commonErrorResponses,
    },
  },
  {
    method: 'patch',
    path: '/auth/me',
    operationId: 'updateCurrentUser',
    summary: 'Update current user profile',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: jsonRequest(updateProfileBodySchema),
    responses: {
      200: jsonResponse(UPDATE_PROFILE_SUCCESS_MESSAGE, updateProfileResponseSchema),

      ...badRequestErrorResponse,

      ...authRequiredErrorResponse,

      ...currentUserNotFoundErrorResponse,

      ...commonErrorResponses,
    },
  },
] satisfies RouteDoc[];
