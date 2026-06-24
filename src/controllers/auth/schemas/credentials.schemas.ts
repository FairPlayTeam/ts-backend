import { z } from '../../../docs/zod.js';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../../../config/constants.js';
import {
  LOGIN_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../../../services/auth/auth.messages.js';
import {
  authSessionResponseSchema,
  authUserResponseSchema,
  emailSchema,
  passwordSchema,
  responseMessageSchema,
  sixDigitCodeSchema,
} from './shared.schemas.js';

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
      .openapi({ example: 'creator@example.com' }),
    password: z
      .string()
      .min(1, 'Password is required')
      .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
      .openapi({
        format: 'password',
        example: 'FairPlay2026!',
      }),
  })
  .strict()
  .openapi('LoginRequest');

export const loginSchema = z.object({
  body: loginBodySchema,
});

export const verifyEmailBodySchema = z
  .object({
    email: emailSchema,
    code: sixDigitCodeSchema('Verification', 'Six-digit verification code sent by email.'),
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

export const registerResponseSchema = z
  .object({
    message: responseMessageSchema(REGISTER_SUCCESS_MESSAGE),
  })
  .openapi('RegisterResponse');

export const loginResponseSchema = z
  .object({
    message: responseMessageSchema(LOGIN_SUCCESS_MESSAGE),
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
    message: responseMessageSchema(VERIFY_EMAIL_SUCCESS_MESSAGE),
  })
  .openapi('VerifyEmailResponse');

export const resendVerificationResponseSchema = z
  .object({
    message: responseMessageSchema(RESEND_VERIFICATION_EMAIL_MESSAGE),
  })
  .openapi('ResendVerificationResponse');

export const requestPasswordResetBodySchema = z
  .object({
    email: emailSchema,
  })
  .strict()
  .openapi('RequestPasswordResetRequest');

export const requestPasswordResetResponseSchema = z
  .object({
    message: responseMessageSchema(RESET_PASSWORD_EMAIL_MESSAGE),
  })
  .openapi('RequestPasswordResetResponse');

export const requestPasswordResetSchema = z.object({
  body: requestPasswordResetBodySchema,
});

export const resetPasswordBodySchema = z
  .object({
    email: emailSchema,
    code: sixDigitCodeSchema('Password reset', 'Six-digit password reset code sent by email.'),
    password: passwordSchema,
  })
  .strict()
  .openapi('ResetPasswordRequest');

export const resetPasswordResponseSchema = z
  .object({
    message: responseMessageSchema(RESET_PASSWORD_SUCCESS_MESSAGE),
    sessionsLoggedOut: z.number().int().nonnegative().openapi({ example: 3 }),
  })
  .openapi('ResetPasswordResponse');

export const resetPasswordSchema = z.object({
  body: resetPasswordBodySchema,
});

export type RegisterRequestBody = z.infer<typeof registerSchema>['body'];
export type LoginRequestBody = z.infer<typeof loginSchema>['body'];
export type VerifyEmailRequestBody = z.infer<typeof verifyEmailSchema>['body'];
export type ResendVerificationRequestBody = z.infer<typeof resendVerificationSchema>['body'];
export type RequestPasswordResetRequestBody = z.infer<typeof requestPasswordResetSchema>['body'];
export type ResetPasswordRequestBody = z.infer<typeof resetPasswordSchema>['body'];
