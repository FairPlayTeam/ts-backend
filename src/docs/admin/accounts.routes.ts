import {
  adminAccountsQuerySchema,
  adminAccountsResponseSchema,
  banAdminAccountParamsSchema,
  banAdminAccountRequestSchema,
  banAdminAccountResponseSchema,
} from '../../controllers/admin.schemas.js';
import { INSUFFICIENT_PERMISSIONS_MESSAGE } from '../../middleware/routeProtection.js';
import { jsonRequest, jsonResponse } from '../openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from '../registry.js';
import { BAN_ACCOUNT_SUCCESS_MESSAGE } from '../../services/admin/admin.messages.js';

export const adminAccountRouteDocs = [
  {
    method: 'get',
    path: '/admin/users',
    summary: 'List user accounts for administrators',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: adminAccountsQuerySchema,
    },
    responses: {
      200: jsonResponse('Paginated account list', adminAccountsResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      403: jsonResponse(INSUFFICIENT_PERMISSIONS_MESSAGE, ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),

      503: jsonResponse('Object storage unavailable', ApiErrorSchema),
    },
  },
  {
    method: 'post',
    path: '/admin/users/{userId}/ban',
    summary: 'Ban a user account',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: banAdminAccountParamsSchema,
      ...jsonRequest(banAdminAccountRequestSchema),
    },
    responses: {
      200: jsonResponse(BAN_ACCOUNT_SUCCESS_MESSAGE, banAdminAccountResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      403: jsonResponse(
        `${INSUFFICIENT_PERMISSIONS_MESSAGE}, self-ban attempt, or role hierarchy violation`,
        ApiErrorSchema,
      ),

      404: jsonResponse('Account not found', ApiErrorSchema),

      409: jsonResponse('Account is already banned', ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),
    },
  },
] satisfies RouteDoc[];
