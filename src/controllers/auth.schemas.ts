import '../docs/zod.js';
import { z } from 'zod';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../config/constants.js';

const emailSchema = z
  .string()
  .trim()
  .email('Invalid email format')
  .max(EMAIL_MAX_LENGTH)
  .transform((v) => v.toLowerCase())
  .openapi({ example: 'user@example.com' });

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
    email: emailSchema,
    username: z
      .string()
      .trim()
      .min(USERNAME_MIN_LENGTH)
      .max(USERNAME_MAX_LENGTH)
      .regex(/^[a-z0-9_]+$/i, 'Username may only contain letters, numbers, and underscores')
      .transform((v) => v.toLowerCase())
      .openapi({ example: 'fairplay_user' }),
    password: passwordSchema,
  })
  .strict()
  .openapi('RegisterRequest');

export const registerSchema = z.object({
  body: registerBodySchema,
});

export const loginBodySchema = z
  .object({
    emailOrUsername: z
      .string()
      .trim()
      .min(1, 'Email or username is required')
      .max(EMAIL_MAX_LENGTH)
      .transform((value) => value.toLowerCase())
      .openapi({ example: 'user@example.com' }),
    password: z
      .string()
      .min(1, 'Password is required')
      .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
      .openapi({
        format: 'password',
        example: 'Password1!',
      }),
  })
  .strict()
  .openapi('LoginRequest');

export const loginSchema = z.object({
  body: loginBodySchema,
});

export const verifyEmailBodySchema = z
  .object({
    token: z
      .string()
      .trim()
      .length(64, 'Verification token must be 64 characters')
      .regex(/^[a-f0-9]+$/i, 'Verification token must be hexadecimal')
      .transform((value) => value.toLowerCase())
      .openapi({
        description: 'Raw email verification token from the frontend verification link.',
        example: 'd9f1f7d7b9d24e5c9f9b6a81a9a2eb1b2c1b0c9e7d6f5a4b3c2d1e0f9a8b7c6d',
      }),
  })
  .strict()
  .openapi('VerifyEmailRequest');

export const verifyEmailSchema = z.object({
  body: verifyEmailBodySchema,
});

export const resendVerificationBodySchema = z
  .object({
    email: emailSchema,
  })
  .strict()
  .openapi('ResendVerificationRequest');

export const resendVerificationSchema = z.object({
  body: resendVerificationBodySchema,
});

const authUserResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  email: z.string().email().openapi({ example: 'user@example.com' }),
  username: z.string().openapi({ example: 'fairplay_user' }),
  role: z.string().openapi({ example: 'user' }),
});

const authSessionResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  expiresAt: z.string().datetime().openapi({ example: '2026-01-31T00:00:00.000Z' }),
});

export const registerResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Account created. Please verify your email.' }),
  })
  .openapi('RegisterResponse');

export const loginResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Login successful' }),
    user: authUserResponseSchema,
    sessionKey: z.string().openapi({
      description: 'Bearer session key. Returned once at login and stored hashed server-side.',
      example: 'd9f1f7d7b9d24e5c9f9b6a81a9a2eb1b2c1b0c9e7d6f5a4b3c2d1e0f9a8b7c6d',
    }),
    session: authSessionResponseSchema,
  })
  .openapi('LoginResponse');

export const verifyEmailResponseSchema = loginResponseSchema
  .extend({
    message: z.string().openapi({ example: 'Email successfully verified' }),
  })
  .openapi('VerifyEmailResponse');

export const resendVerificationResponseSchema = z
  .object({
    message: z
      .string()
      .openapi({ example: 'If this email exists and is unverified, a new link has been sent.' }),
  })
  .openapi('ResendVerificationResponse');

export const currentUserResponseSchema = z
  .object({
    user: authUserResponseSchema,
    session: authSessionResponseSchema,
  })
  .openapi('CurrentUserResponse');

export const userSessionsResponseSchema = z
  .object({
    sessions: z.array(
      z.object({
        id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
        sessionKeySuffix: z.string().nullable().openapi({ example: '9a8b7c6d' }),
        ipAddress: z.string().nullable().openapi({ example: '127.0.0.1' }),
        userAgent: z.string().nullable().openapi({ example: 'Mozilla/5.0' }),
        deviceInfo: z.string().nullable().openapi({ example: 'Mozilla/5.0' }),
        isCurrent: z.boolean().openapi({ example: true }),
        createdAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
        lastUsedAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
        expiresAt: z.string().datetime().openapi({ example: '2026-01-31T00:00:00.000Z' }),
      }),
    ),
    total: z.number().int().nonnegative().openapi({ example: 1 }),
  })
  .openapi('UserSessionsResponse');

export const logoutAllSessionsResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'All sessions logged out successfully' }),
    sessionsLoggedOut: z.number().int().nonnegative().openapi({ example: 3 }),
  })
  .openapi('LogoutAllSessionsResponse');

export type RegisterRequestBody = z.infer<typeof registerSchema>['body'];
export type LoginRequestBody = z.infer<typeof loginSchema>['body'];
export type VerifyEmailRequestBody = z.infer<typeof verifyEmailSchema>['body'];
export type ResendVerificationRequestBody = z.infer<typeof resendVerificationSchema>['body'];
