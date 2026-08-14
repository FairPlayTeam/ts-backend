import { ApiErrorSchema, type RouteDoc } from '../registry.js';
import {
  badRequestErrorResponse,
  commonErrorResponses,
  jsonRequest,
  jsonResponse,
} from './shared.js';
import {
  requestPasswordResetBodySchema,
  requestPasswordResetResponseSchema,
  resetPasswordBodySchema,
  resetPasswordResponseSchema,
} from '../../controllers/auth.schemas.js';

export const passwordResetRouteDocs = [
  {
    method: 'post',
    path: '/auth/forgot-password',
    operationId: 'requestUserPasswordReset',
    summary: 'Request a password reset code',
    tags: ['Auth'],
    request: jsonRequest(requestPasswordResetBodySchema),
    responses: {
      200: jsonResponse('Password reset request accepted', requestPasswordResetResponseSchema),

      ...badRequestErrorResponse,

      409: jsonResponse('Already authenticated', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'post',
    path: '/auth/reset-password',
    operationId: 'resetUserPassword',
    summary: 'Reset account password using an emailed code',
    tags: ['Auth'],
    request: jsonRequest(resetPasswordBodySchema),
    responses: {
      200: jsonResponse('Password reset successfully', resetPasswordResponseSchema),

      ...badRequestErrorResponse,

      403: jsonResponse('Account is not allowed to reset password', ApiErrorSchema),

      409: jsonResponse('Password reset state changed', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
] satisfies RouteDoc[];
