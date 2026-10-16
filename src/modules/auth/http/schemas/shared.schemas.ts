import { z } from '../../../../docs/zod.js';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  SESSION_DEVICE_INFO_MAX_LENGTH,
  SESSION_IP_ADDRESS_MAX_LENGTH,
  SESSION_USER_AGENT_MAX_LENGTH,
} from '../../../../config/constants.js';
import { AUTH_ROLES } from '../../roles.js';
import { SESSION_PUBLIC_ID_EXAMPLE, SESSION_PUBLIC_ID_PATTERN } from '../../sessions/types.js';
import { relativeAssetPathSchema } from '../../../../controllers/shared/asset.schemas.js';
import { isPasswordNulFree, isPasswordWithinByteLimit } from '../../credentials/passwordPolicy.js';
import { PASSWORD_CONTAINS_NUL_MESSAGE, PASSWORD_TOO_LONG_MESSAGE } from '../../errors.js';

export const responseMessageSchema = (example: string) => z.string().openapi({ example });

export const emailSchema = z
  .string()
  .trim()
  .email('Invalid email format')
  .max(EMAIL_MAX_LENGTH)
  .transform((v) => v.toLowerCase())
  .openapi({ example: 'creator@example.com' });

export const sixDigitCodeSchema = (label: string, description: string) =>
  z
    .string()
    .trim()
    .length(6, `${label} code must be 6 digits`)
    .regex(/^\d{6}$/, `${label} code must contain only digits`)
    .openapi({
      description,
      example: '123456',
    });

export const passwordInputSchema = z
  .string()
  .refine(isPasswordWithinByteLimit, PASSWORD_TOO_LONG_MESSAGE)
  .refine(isPasswordNulFree, PASSWORD_CONTAINS_NUL_MESSAGE)
  .openapi({
    format: 'password',
    description: `At most ${PASSWORD_MAX_BYTES} UTF-8 bytes. NUL (U+0000) is forbidden. Used verbatim, without trimming or normalization.`,
  });

export const passwordSchema = passwordInputSchema
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(
    /[!@#$%^&*()_+\-=\\[\]{};':"|,.<>/?]/,
    'Password must contain at least one special character (!@#$...)',
  )
  .openapi({
    format: 'password',
    description: `At most ${PASSWORD_MAX_BYTES} UTF-8 bytes. NUL (U+0000) is forbidden. Must contain at least one uppercase letter, one number, and one special character. Used verbatim, without trimming or normalization.`,
    example: 'Password1!',
  });

export const authUserResponseSchema = z.object({
  email: z.string().email().openapi({ example: 'creator@example.com' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'Neal Mohan' }),
  bio: z.string().nullable().openapi({
    example: 'A new fairplayer who is looking for a fairer way to share videos.',
  }),
  role: z.enum(AUTH_ROLES).openapi({
    example: 'user',
  }),
});

export const authUserProfileResponseSchema = authUserResponseSchema.extend({
  avatarUrl: relativeAssetPathSchema.nullable().openapi({
    example: '/profiles/fairplay_creator/avatar',
  }),
  bannerUrl: relativeAssetPathSchema.nullable().openapi({
    example: '/profiles/fairplay_creator/banner',
  }),
});

export const authSessionResponseSchema = z.object({
  id: z.string().regex(SESSION_PUBLIC_ID_PATTERN).openapi({ example: SESSION_PUBLIC_ID_EXAMPLE }),
  expiresAt: z.string().datetime().openapi({ example: '2026-01-31T00:00:00.000Z' }),
});

export const sessionIpAddressResponseSchema = z
  .string()
  .max(SESSION_IP_ADDRESS_MAX_LENGTH)
  .nullable()
  .openapi({ example: '127.0.0.1' });

export const sessionUserAgentResponseSchema = z
  .string()
  .max(SESSION_USER_AGENT_MAX_LENGTH)
  .nullable()
  .openapi({ example: 'Mozilla/5.0' });

export const sessionDeviceInfoResponseSchema = z
  .string()
  .max(SESSION_DEVICE_INFO_MAX_LENGTH)
  .nullable()
  .openapi({ example: 'Mozilla/5.0' });

export const sensitiveActionReauthenticationBodySchema = z
  .object({
    currentPassword: passwordInputSchema.min(1, 'Current password is required').openapi({
      format: 'password',
      description: `Current account password required to confirm this sensitive action. At most ${PASSWORD_MAX_BYTES} UTF-8 bytes. NUL (U+0000) is forbidden. Used verbatim, without trimming or normalization.`,
      example: 'Password1!',
    }),
  })
  .strict()
  .openapi('SensitiveActionReauthenticationRequest');

export const sensitiveActionReauthenticationSchema = z.object({
  body: sensitiveActionReauthenticationBodySchema,
});

export type SensitiveActionReauthenticationRequestBody = z.infer<
  typeof sensitiveActionReauthenticationBodySchema
>;
