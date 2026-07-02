import { ApiErrorSchema, type RouteDoc } from '../registry.js';
import {
  badRequestErrorResponse,
  commonErrorResponses,
  jsonRequest,
  jsonResponse,
} from './shared.js';
import {
  loginBodySchema,
  loginResponseSchema,
  registerBodySchema,
  registerResponseSchema,
  resendVerificationBodySchema,
  resendVerificationResponseSchema,
  verifyEmailBodySchema,
  verifyEmailResponseSchema,
} from '../../controllers/auth.schemas.js';
import { LOGIN_SUCCESS_MESSAGE } from '../../services/auth/auth.messages.js';
import { INVALID_CREDENTIALS_MESSAGE } from '../../services/auth.errors.js';

export const credentialsRouteDocs = [
  {
    method: 'post',
    path: '/auth/register',
    summary: 'Register a new user',
    tags: ['Auth'],
    request: jsonRequest(registerBodySchema),
    responses: {
      201: jsonResponse('Account created', registerResponseSchema),

      ...badRequestErrorResponse,

      409: jsonResponse('Email or username already in use', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'post',
    path: '/auth/login',
    summary: 'Log in with an email or username',
    tags: ['Auth'],
    request: jsonRequest(loginBodySchema),
    responses: {
      200: jsonResponse(LOGIN_SUCCESS_MESSAGE, loginResponseSchema),

      401: jsonResponse(INVALID_CREDENTIALS_MESSAGE, ApiErrorSchema),

      403: jsonResponse('Account is not allowed to log in', ApiErrorSchema),

      ...badRequestErrorResponse,
      ...commonErrorResponses,
    },
  },
  {
    method: 'post',
    path: '/auth/verify-email',
    summary: 'Verify an email address',
    tags: ['Auth'],
    request: jsonRequest(verifyEmailBodySchema),
    responses: {
      200: jsonResponse('Email verified and session created', verifyEmailResponseSchema),

      ...badRequestErrorResponse,

      403: jsonResponse('Account is not allowed to verify email', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'post',
    path: '/auth/resend-verification',
    summary: 'Resend an email verification code',
    tags: ['Auth'],
    request: jsonRequest(resendVerificationBodySchema),
    responses: {
      200: jsonResponse('Verification resend request accepted', resendVerificationResponseSchema),

      ...badRequestErrorResponse,

      409: jsonResponse('Already authenticated', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
] satisfies RouteDoc[];
