import { Router } from 'express';
import { ApiErrorSchema, ValidationErrorSchema, registerRoute } from '../docs/registry.js';
import { authLimiter } from '../middleware/limiters.js';
import { validate } from '../middleware/validation.js';
import { createAuthController } from '../controllers/auth.controller.js';
import {
  registerBodySchema,
  registerResponseSchema,
  registerSchema,
  resendVerificationBodySchema,
  resendVerificationResponseSchema,
  resendVerificationSchema,
} from '../controllers/auth.schemas.js';
import { authService } from '../auth.instance.js';

const router = Router();
const { register, resendVerification } = createAuthController({ authService });

router.post('/register', authLimiter, validate(registerSchema), register);
router.post(
  '/resend-verification',
  authLimiter,
  validate(resendVerificationSchema),
  resendVerification,
);

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
    201: {
      description: 'Account created',
      content: {
        'application/json': {
          schema: registerResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request body',
      content: {
        'application/json': {
          schema: ValidationErrorSchema,
        },
      },
    },
    413: {
      description: 'Payload too large',
      content: {
        'application/json': {
          schema: ApiErrorSchema,
        },
      },
    },
    409: {
      description: 'Email or username already in use',
      content: {
        'application/json': {
          schema: ApiErrorSchema,
        },
      },
    },
    429: {
      description: 'Too many auth attempts',
      content: {
        'application/json': {
          schema: ApiErrorSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: ApiErrorSchema,
        },
      },
    },
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
    200: {
      description: 'Verification resend request accepted',
      content: {
        'application/json': {
          schema: resendVerificationResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request body',
      content: {
        'application/json': {
          schema: ValidationErrorSchema,
        },
      },
    },
    413: {
      description: 'Payload too large',
      content: {
        'application/json': {
          schema: ApiErrorSchema,
        },
      },
    },
    429: {
      description: 'Too many auth attempts',
      content: {
        'application/json': {
          schema: ApiErrorSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: ApiErrorSchema,
        },
      },
    },
  },
});

export default router;
