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
import { ApiErrorSchema } from '../registry.js';

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

      409: jsonResponse(
        'A personal data export or account deletion is already in progress',
        ApiErrorSchema,
      ),

      503: jsonResponse('Personal account operation coordination is unavailable', ApiErrorSchema),
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
      200: jsonResponse('Account deletion result', deleteAccountResponseSchema),

      ...sensitiveActionErrorResponses('Account is not allowed to delete account'),

      409: jsonResponse(
        'A personal data export or account deletion is already in progress',
        ApiErrorSchema,
      ),

      503: jsonResponse(
        'Personal account operation coordination or deletion transaction is temporarily unavailable',
        ApiErrorSchema,
      ),
    },
  },
] satisfies RouteDoc[];
