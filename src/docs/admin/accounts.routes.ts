import {
  adminAccountsQuerySchema,
  adminAccountsResponseSchema,
} from '../../controllers/admin.schemas.js';
import { INSUFFICIENT_PERMISSIONS_MESSAGE } from '../../middleware/routeProtection.js';
import { jsonResponse } from '../openapi.helpers.js';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from '../registry.js';

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
] satisfies RouteDoc[];
