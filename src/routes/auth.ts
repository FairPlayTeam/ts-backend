import { Router, type RequestHandler } from 'express';
import { ApiErrorSchema, ApiOrValidationErrorSchema, type RouteDoc } from '../docs/registry.js';
import { createAuthenticateSession } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuthController } from '../controllers/auth.controller.js';
import type { AuthService } from '../services/auth.types.js';
import {
  currentUserResponseSchema,
  deleteAccountResponseSchema,
  deleteAvatarResponseSchema,
  deleteBannerResponseSchema,
  logoutAllSessionsResponseSchema,
  logoutOtherSessionsResponseSchema,
  logoutSessionParamsSchema,
  logoutSessionResponseSchema,
  logoutSessionSchema,
  loginBodySchema,
  loginResponseSchema,
  loginSchema,
  registerBodySchema,
  registerResponseSchema,
  registerSchema,
  requestPasswordResetBodySchema,
  requestPasswordResetResponseSchema,
  requestPasswordResetSchema,
  resetPasswordBodySchema,
  resetPasswordResponseSchema,
  resetPasswordSchema,
  resendVerificationBodySchema,
  resendVerificationResponseSchema,
  resendVerificationSchema,
  userDataExportResponseSchema,
  uploadAvatarBodySchema,
  uploadAvatarResponseSchema,
  uploadBannerBodySchema,
  uploadBannerResponseSchema,
  updateProfileBodySchema,
  updateProfileResponseSchema,
  updateProfileSchema,
  userSessionsQuerySchema,
  userSessionsResponseSchema,
  userSessionsSchema,
  verifyEmailBodySchema,
  verifyEmailResponseSchema,
  verifyEmailSchema,
} from '../controllers/auth.schemas.js';
import { jsonResponse } from '../docs/openapi.helpers.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import {
  ALREADY_AUTHENTICATED_PASSWORD_RESET_MESSAGE,
  ALREADY_AUTHENTICATED_VERIFICATION_MESSAGE,
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
} from '../services/auth/auth.messages.js';
import { INVALID_CREDENTIALS_MESSAGE } from '../services/auth.errors.js';
import { createSingleFileUpload } from '../middleware/upload.js';

type AuthRouterDependencies = {
  authService: AuthService;
  profileMediaMaxUploadBytes: number;
  authLimiter: RequestHandler;
  registrationIdentifierLimiter: RequestHandler;
  loginIdentifierLimiter: RequestHandler;
  passwordResetEmailCooldown: RequestHandler;
  passwordResetIdentifierLimiter: RequestHandler;
  resendVerificationEmailCooldown: RequestHandler;
  resendVerificationIdentifierLimiter: RequestHandler;
};

const createAuthRouter = ({
  authService,
  profileMediaMaxUploadBytes,
  authLimiter,
  registrationIdentifierLimiter,
  loginIdentifierLimiter,
  passwordResetEmailCooldown,
  passwordResetIdentifierLimiter,
  resendVerificationEmailCooldown,
  resendVerificationIdentifierLimiter,
}: AuthRouterDependencies) => {
  const router = Router();
  const {
    register,
    login,
    verifyEmail,
    resendVerification,
    me,
    updateMe,
    uploadAvatar,
    deleteAvatar,
    uploadBanner,
    deleteBanner,
    sessions,
    logoutAll,
    logoutOthers,
    logoutSession,
    requestPasswordReset,
    resetPassword,
    exportMe,
    deleteMe,
  } = createAuthController({
    authService,
  });
  const authenticateSession = createAuthenticateSession({ authService });
  const protect = createRouteProtector({ authService });
  const uploadAvatarFile = createSingleFileUpload({
    fieldName: 'avatar',
    maxFileSizeBytes: profileMediaMaxUploadBytes,
  });
  const uploadBannerFile = createSingleFileUpload({
    fieldName: 'banner',
    maxFileSizeBytes: profileMediaMaxUploadBytes,
  });

  router.post(
    '/register',
    authLimiter,
    validate(registerSchema),
    registrationIdentifierLimiter,
    register,
  );
  router.post('/login', authLimiter, validate(loginSchema), loginIdentifierLimiter, login);
  router.post('/verify-email', authLimiter, validate(verifyEmailSchema), verifyEmail);
  router.post(
    '/resend-verification',
    authLimiter,
    ...protect({
      access: 'guest',
      conflictMessage: ALREADY_AUTHENTICATED_VERIFICATION_MESSAGE,
    }),
    validate(resendVerificationSchema),
    resendVerificationIdentifierLimiter,
    resendVerificationEmailCooldown,
    resendVerification,
  );
  router.get('/me', ...protect(), me);
  router.get('/me/export', ...protect(), exportMe);
  router.delete('/me', ...protect(), deleteMe);
  router.patch('/me', ...protect(), validate(updateProfileSchema), updateMe);
  router.put('/me/avatar', ...protect(), uploadAvatarFile, uploadAvatar);
  router.delete('/me/avatar', ...protect(), deleteAvatar);
  router.put('/me/banner', ...protect(), uploadBannerFile, uploadBanner);
  router.delete('/me/banner', ...protect(), deleteBanner);
  router.get('/sessions', authenticateSession, validate(userSessionsSchema), sessions);
  router.delete('/sessions/all', authenticateSession, logoutAll);
  router.delete('/sessions/others/all', authenticateSession, logoutOthers);
  router.delete(
    '/sessions/:sessionId',
    authenticateSession,
    validate(logoutSessionSchema),
    logoutSession,
  );
  router.post(
    '/forgot-password',
    authLimiter,
    ...protect({
      access: 'guest',
      conflictMessage: ALREADY_AUTHENTICATED_PASSWORD_RESET_MESSAGE,
    }),
    validate(requestPasswordResetSchema),
    passwordResetIdentifierLimiter,
    passwordResetEmailCooldown,
    requestPasswordReset,
  );
  router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);

  return router;
};

export const createRouter = createAuthRouter;

const commonErrorResponses = {
  413: jsonResponse('Payload too large', ApiErrorSchema),

  429: jsonResponse('Too many requests', ApiErrorSchema),

  500: jsonResponse('Internal server error', ApiErrorSchema),
};

const badRequestErrorResponse = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
};

const serviceUnavailableErrorResponse = {
  503: jsonResponse('Object storage unavailable', ApiErrorSchema),
};

const userMediaUploadResponses = (
  successMessage: string,
  responseSchema: Parameters<typeof jsonResponse>[1],
) => ({
  200: jsonResponse(successMessage, responseSchema),

  ...badRequestErrorResponse,

  401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

  413: jsonResponse('Uploaded file too large', ApiErrorSchema),

  ...serviceUnavailableErrorResponse,

  429: jsonResponse('Too many requests', ApiErrorSchema),

  500: jsonResponse('Internal server error', ApiErrorSchema),
});

const userMediaDeleteResponses = (
  successMessage: string,
  responseSchema: Parameters<typeof jsonResponse>[1],
) => ({
  200: jsonResponse(successMessage, responseSchema),

  401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

  ...serviceUnavailableErrorResponse,

  429: jsonResponse('Too many requests', ApiErrorSchema),

  500: jsonResponse('Internal server error', ApiErrorSchema),
});

export const routeDocs = [
  {
    method: 'post',
    path: '/auth/register',
    summary: 'Register a new user',
    tags: ['Auth'],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registerBodySchema,
          },
        },
      },
    },
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
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: loginBodySchema,
          },
        },
      },
    },
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
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: verifyEmailBodySchema,
          },
        },
      },
    },
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
    summary: 'Resend an email verification link',
    tags: ['Auth'],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: resendVerificationBodySchema,
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Verification resend request accepted', resendVerificationResponseSchema),

      ...badRequestErrorResponse,

      409: jsonResponse('Already authenticated', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'get',
    path: '/auth/me',
    summary: 'Get current user profile data',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Current user profile', currentUserResponseSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...serviceUnavailableErrorResponse,

      ...commonErrorResponses,
    },
  },
  {
    method: 'get',
    path: '/auth/me/export',
    summary: 'Export current user data',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Current user data export', userDataExportResponseSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'delete',
    path: '/auth/me',
    summary: 'Delete current user account',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse(DELETE_ACCOUNT_SUCCESS_MESSAGE, deleteAccountResponseSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'get',
    path: '/auth/sessions',
    summary: 'Get current user active sessions',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: {
      query: userSessionsQuerySchema,
    },
    responses: {
      200: jsonResponse('Current user active sessions', userSessionsResponseSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'delete',
    path: '/auth/sessions/all',
    summary: 'Logout from all sessions including current',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse(LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE, logoutAllSessionsResponseSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'delete',
    path: '/auth/sessions/others/all',
    summary: 'Logout from other sessions while keeping the current session',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse(LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE, logoutOtherSessionsResponseSchema),

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'delete',
    path: '/auth/sessions/{sessionId}',
    summary: 'Logout from a specific session',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: {
      params: logoutSessionParamsSchema,
    },
    responses: {
      200: jsonResponse(LOGOUT_SESSION_SUCCESS_MESSAGE, logoutSessionResponseSchema),

      ...badRequestErrorResponse,

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'patch',
    path: '/auth/me',
    summary: 'Update current user profile',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: updateProfileBodySchema,
          },
        },
      },
    },
    responses: {
      200: jsonResponse(UPDATE_PROFILE_SUCCESS_MESSAGE, updateProfileResponseSchema),

      ...badRequestErrorResponse,

      401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
  {
    method: 'put',
    path: '/auth/me/avatar',
    summary: 'Upload or replace current user avatar',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: uploadAvatarBodySchema,
          },
        },
      },
    },
    responses: userMediaUploadResponses(UPLOAD_AVATAR_SUCCESS_MESSAGE, uploadAvatarResponseSchema),
  },
  {
    method: 'delete',
    path: '/auth/me/avatar',
    summary: 'Delete current user avatar',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: userMediaDeleteResponses(DELETE_AVATAR_SUCCESS_MESSAGE, deleteAvatarResponseSchema),
  },
  {
    method: 'put',
    path: '/auth/me/banner',
    summary: 'Upload or replace current user banner',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: uploadBannerBodySchema,
          },
        },
      },
    },
    responses: userMediaUploadResponses(UPLOAD_BANNER_SUCCESS_MESSAGE, uploadBannerResponseSchema),
  },
  {
    method: 'delete',
    path: '/auth/me/banner',
    summary: 'Delete current user banner',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: userMediaDeleteResponses(DELETE_BANNER_SUCCESS_MESSAGE, deleteBannerResponseSchema),
  },
  {
    method: 'post',
    path: '/auth/forgot-password',
    summary: 'Request a password reset email',
    tags: ['Auth'],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: requestPasswordResetBodySchema,
          },
        },
      },
    },
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
    summary: 'Reset account password using an emailed token',
    tags: ['Auth'],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: resetPasswordBodySchema,
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Password reset successfully', resetPasswordResponseSchema),

      ...badRequestErrorResponse,

      403: jsonResponse('Account is not allowed to reset password', ApiErrorSchema),

      409: jsonResponse('Password reset state changed', ApiErrorSchema),

      ...commonErrorResponses,
    },
  },
] satisfies RouteDoc[];
