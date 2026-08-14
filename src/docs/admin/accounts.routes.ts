import {
  adminAccountParamsSchema,
  adminAccountsQuerySchema,
  adminAccountsResponseSchema,
  banAdminAccountRequestSchema,
  banAdminAccountResponseSchema,
  unbanAdminAccountResponseSchema,
  updateAdminAccountRoleRequestSchema,
  updateAdminAccountRoleResponseSchema,
} from '../../controllers/admin.schemas.js';
import { INSUFFICIENT_PERMISSIONS_MESSAGE } from '../../middleware/routeProtection.js';
import { jsonRequest, jsonResponse } from '../openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from '../registry.js';
import {
  BAN_ACCOUNT_SUCCESS_MESSAGE,
  UNBAN_ACCOUNT_SUCCESS_MESSAGE,
  UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE,
} from '../../services/admin/admin.messages.js';

export const adminAccountRouteDocs = [
  {
    method: 'get',
    path: '/admin/users',
    operationId: 'listAdminUserAccounts',
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
    },
  },
  {
    method: 'post',
    path: '/admin/users/{userId}/ban',
    operationId: 'banUserAccount',
    summary: 'Ban a user account',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: adminAccountParamsSchema,
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
  {
    method: 'post',
    path: '/admin/users/{userId}/unban',
    operationId: 'unbanUserAccount',
    summary: 'Unban a user account',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: adminAccountParamsSchema,
    },
    responses: {
      200: jsonResponse(UNBAN_ACCOUNT_SUCCESS_MESSAGE, unbanAdminAccountResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      403: jsonResponse(
        `${INSUFFICIENT_PERMISSIONS_MESSAGE}, self-unban attempt, or role hierarchy violation`,
        ApiErrorSchema,
      ),

      404: jsonResponse('Account not found', ApiErrorSchema),

      409: jsonResponse('Account is not banned', ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),
    },
  },
  {
    method: 'patch',
    path: '/admin/users/{userId}/role',
    operationId: 'updateUserAccountRole',
    summary: 'Update a user account role',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: adminAccountParamsSchema,
      ...jsonRequest(updateAdminAccountRoleRequestSchema),
    },
    responses: {
      200: jsonResponse(UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE, updateAdminAccountRoleResponseSchema),

      400: jsonResponse('Bad request', ApiOrValidationErrorSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      403: jsonResponse(
        `${INSUFFICIENT_PERMISSIONS_MESSAGE}, self-update attempt, or role hierarchy violation`,
        ApiErrorSchema,
      ),

      404: jsonResponse('Account not found', ApiErrorSchema),

      409: jsonResponse('Account already has this role', ApiErrorSchema),

      429: jsonResponse('Too many requests', ApiErrorSchema),

      500: jsonResponse('Internal server error', ApiErrorSchema),
    },
  },
] satisfies RouteDoc[];
