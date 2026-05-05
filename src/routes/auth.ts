import { Router } from 'express';
import { ApiErrorSchema, ValidationErrorSchema, registerRoute } from '../docs/registry.js';
import { authLimiter } from '../middleware/limiters.js';
import { validate } from '../middleware/validation.js';
import { register } from '../controllers/auth.controller.js';
import {
  registerBodySchema,
  registerResponseSchema,
  registerSchema,
} from '../controllers/auth.schemas.js';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);

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

export default router;
