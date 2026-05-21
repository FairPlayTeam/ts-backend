import { Router } from 'express';
import { ApiErrorSchema, ApiOrValidationErrorSchema, registerRoute } from '../docs/registry.js';
import { createAuthenticateSession } from '../middleware/auth.js';
import { authLimiter } from '../middleware/limiters.js';
import { validate } from '../middleware/validation.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { type AuthService } from '../services/auth.types.js';
import {
  currentUserResponseSchema,
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
  resendVerificationBodySchema,
  resendVerificationResponseSchema,
  resendVerificationSchema,
  updateProfileBodySchema,
  updateProfileResponseSchema,
  updateProfileSchema,
  userSessionsResponseSchema,
  verifyEmailBodySchema,
  verifyEmailResponseSchema,
  verifyEmailSchema,
} from '../controllers/auth.schemas.js';
import { jsonResponse } from '../docs/openapi.helpers.js';

type AuthRouterDependencies = {
  authService: AuthService;
};

const createAuthRouter = ({ authService }: AuthRouterDependencies) => {
  const router = Router();
  const {
    register,
    login,
    verifyEmail,
    resendVerification,
    me,
    updateMe,
    sessions,
    logoutAll,
    logoutOthers,
    logoutSession,
  } = createAuthController({
    authService,
  });
  const authenticateSession = createAuthenticateSession({ authService });

  router.post('/register', authLimiter, validate(registerSchema), register);
  router.post('/login', authLimiter, validate(loginSchema), login);
  router.post('/verify-email', authLimiter, validate(verifyEmailSchema), verifyEmail);
  router.post(
    '/resend-verification',
    authLimiter,
    validate(resendVerificationSchema),
    resendVerification,
  );
  router.get('/me', authenticateSession, me);
  router.patch('/me', authenticateSession, validate(updateProfileSchema), updateMe);
  router.get('/sessions', authenticateSession, sessions);
  router.delete('/sessions/all', authenticateSession, logoutAll);
  router.delete('/sessions/others/all', authenticateSession, logoutOthers);
  router.delete(
    '/sessions/:sessionId',
    authenticateSession,
    validate(logoutSessionSchema),
    logoutSession,
  );

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

registerRoute({
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
});

registerRoute({
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
    200: jsonResponse('Login successful', loginResponseSchema),

    401: jsonResponse('Invalid credentials', ApiErrorSchema),

    403: jsonResponse('Account is not allowed to log in', ApiErrorSchema),

    ...badRequestErrorResponse,
    ...commonErrorResponses,
  },
});

registerRoute({
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
});

registerRoute({
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
    ...commonErrorResponses,
  },
});

registerRoute({
  method: 'get',
  path: '/auth/me',
  summary: 'Get current user profile data',
  tags: ['Auth'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: jsonResponse('Current user profile', currentUserResponseSchema),

    401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

    ...commonErrorResponses,
  },
});

registerRoute({
  method: 'get',
  path: '/auth/sessions',
  summary: 'Get current user active sessions',
  tags: ['Auth'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: jsonResponse('Current user active sessions', userSessionsResponseSchema),

    401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

    ...commonErrorResponses,
  },
});

registerRoute({
  method: 'delete',
  path: '/auth/sessions/all',
  summary: 'Logout from all sessions including current',
  tags: ['Auth'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: jsonResponse('All sessions logged out successfully', logoutAllSessionsResponseSchema),

    401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

    ...commonErrorResponses,
  },
});

registerRoute({
  method: 'delete',
  path: '/auth/sessions/others/all',
  summary: 'Logout from other sessions while keeping the current session',
  tags: ['Auth'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: jsonResponse('Other sessions logged out successfully', logoutOtherSessionsResponseSchema),

    401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

    ...commonErrorResponses,
  },
});

registerRoute({
  method: 'delete',
  path: '/auth/sessions/{sessionId}',
  summary: 'Logout from a specific session',
  tags: ['Auth'],
  security: [{ bearerAuth: [] }],
  request: {
    params: logoutSessionParamsSchema,
  },
  responses: {
    200: jsonResponse('Session logged out successfully', logoutSessionResponseSchema),

    ...badRequestErrorResponse,

    401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

    ...commonErrorResponses,
  },
});

registerRoute({
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
    200: jsonResponse('Profile updated successfully', updateProfileResponseSchema),

    ...badRequestErrorResponse,

    401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),

    ...commonErrorResponses,
  },
});
