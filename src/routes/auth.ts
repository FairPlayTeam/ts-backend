import { Router } from 'express';
import { ApiErrorSchema, ApiOrValidationErrorSchema, registerRoute } from '../docs/registry.js';
import { createAuthenticateSession } from '../middleware/auth.js';
import { authLimiter } from '../middleware/limiters.js';
import { validate } from '../middleware/validation.js';
import { createAuthController, type AuthService } from '../controllers/auth.controller.js';
import {
  currentUserResponseSchema,
  loginBodySchema,
  loginResponseSchema,
  loginSchema,
  registerBodySchema,
  registerResponseSchema,
  registerSchema,
  resendVerificationBodySchema,
  resendVerificationResponseSchema,
  resendVerificationSchema,
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
  const { register, login, verifyEmail, resendVerification, me } = createAuthController({
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
