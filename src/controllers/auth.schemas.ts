import '../docs/zod.js';
import { z } from 'zod';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../config/constants.js';

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(
    /[!@#$%^&*()_+\-=\\[\]{};':"|,.<>/?]/,
    'Password must contain at least one special character (!@#$...)',
  )
  .openapi({
    format: 'password',
    description:
      'Must contain at least one uppercase letter, one number, and one special character.',
    example: 'Password1!',
  });

export const registerBodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .email('Invalid email format')
      .max(EMAIL_MAX_LENGTH)
      .openapi({ example: 'user@example.com' }),
    username: z
      .string()
      .trim()
      .min(USERNAME_MIN_LENGTH)
      .max(USERNAME_MAX_LENGTH)
      .regex(/^[a-zA-Z0-9_]+$/)
      .openapi({ example: 'fairplay_user' }),
    password: passwordSchema,
  })
  .strict()
  .openapi('RegisterRequest');

export const registerSchema = z.object({
  body: registerBodySchema,
});

export const registerResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Account created. Please verify your email.' }),
  })
  .openapi('RegisterResponse');

export type RegisterRequestBody = z.infer<typeof registerSchema>['body'];
