import type { RouteDoc } from '../registry.js';
import {
  currentUserNotFoundErrorResponse,
  sensitiveActionErrorResponses,
  sensitiveActionReauthenticationRequest,
  jsonResponse,
} from './shared.js';
import {
  deleteAccountResponseSchema,
  userDataExportResponseSchema,
} from '../../controllers/auth.schemas.js';
import { DELETE_ACCOUNT_SUCCESS_MESSAGE } from '../../services/auth/auth.messages.js';

export const accountRouteDocs = [
  {
    method: 'post',
    path: '/auth/me/export',
    summary: 'Export current user data',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: sensitiveActionReauthenticationRequest,
    responses: {
      200: jsonResponse('Current user data export', userDataExportResponseSchema),

      ...sensitiveActionErrorResponses('Account is not allowed to export data'),

      ...currentUserNotFoundErrorResponse,
    },
  },
  {
    method: 'delete',
    path: '/auth/me',
    summary: 'Delete current user account',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: sensitiveActionReauthenticationRequest,
    responses: {
      200: jsonResponse(DELETE_ACCOUNT_SUCCESS_MESSAGE, deleteAccountResponseSchema),

      ...sensitiveActionErrorResponses('Account is not allowed to delete account'),
    },
  },
] satisfies RouteDoc[];
