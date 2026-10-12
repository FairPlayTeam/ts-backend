import { ApiErrorSchema, type RouteDoc } from '../../../../docs/registry.js';
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
} from '../schemas/index.js';
import { LOGIN_SUCCESS_MESSAGE } from '../../messages.js';
import { INVALID_CREDENTIALS_MESSAGE } from '../../errors.js';

export const credentialsRouteDocs = [
  {
    method: 'post',
    path: '/auth/register',
    operationId: 'registerUser',
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
    operationId: 'loginUser',
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
    operationId: 'verifyUserEmail',
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
    operationId: 'resendUserEmailVerification',
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
