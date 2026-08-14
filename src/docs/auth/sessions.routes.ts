import type { RouteDoc } from '../registry.js';
import {
  authRequiredErrorResponse,
  badRequestErrorResponse,
  commonErrorResponses,
  jsonResponse,
  logoutSessionsSensitiveActionResponses,
  sensitiveActionReauthenticationRequest,
} from './shared.js';
import {
  logoutAllSessionsResponseSchema,
  logoutOtherSessionsResponseSchema,
  logoutSessionParamsSchema,
  logoutSessionResponseSchema,
  userSessionsQuerySchema,
  userSessionsResponseSchema,
} from '../../controllers/auth.schemas.js';
import {
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
} from '../../services/auth/auth.messages.js';

export const sessionRouteDocs = [
  {
    method: 'get',
    path: '/auth/sessions',
    operationId: 'listCurrentUserSessions',
    summary: 'Get current user active sessions',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: {
      query: userSessionsQuerySchema,
    },
    responses: {
      200: jsonResponse('Current user active sessions', userSessionsResponseSchema),

      ...authRequiredErrorResponse,

      ...commonErrorResponses,
    },
  },
  {
    method: 'delete',
    path: '/auth/sessions/all',
    operationId: 'logoutAllUserSessions',
    summary: 'Logout from all sessions including current',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: sensitiveActionReauthenticationRequest,
    responses: {
      200: jsonResponse(LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE, logoutAllSessionsResponseSchema),

      ...logoutSessionsSensitiveActionResponses,
    },
  },
  {
    method: 'delete',
    path: '/auth/sessions/others/all',
    operationId: 'logoutOtherUserSessions',
    summary: 'Logout from other sessions while keeping the current session',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: sensitiveActionReauthenticationRequest,
    responses: {
      200: jsonResponse(LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE, logoutOtherSessionsResponseSchema),

      ...logoutSessionsSensitiveActionResponses,
    },
  },
  {
    method: 'delete',
    path: '/auth/sessions/{sessionId}',
    operationId: 'logoutUserSession',
    summary: 'Logout from a specific session',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: {
      params: logoutSessionParamsSchema,
    },
    responses: {
      200: jsonResponse(LOGOUT_SESSION_SUCCESS_MESSAGE, logoutSessionResponseSchema),

      ...badRequestErrorResponse,

      ...authRequiredErrorResponse,

      ...commonErrorResponses,
    },
  },
] satisfies RouteDoc[];
