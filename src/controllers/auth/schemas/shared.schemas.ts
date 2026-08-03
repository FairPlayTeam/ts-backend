import { z } from '../../../docs/zod.js';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SESSION_DEVICE_INFO_MAX_LENGTH,
  SESSION_IP_ADDRESS_MAX_LENGTH,
  SESSION_USER_AGENT_MAX_LENGTH,
} from '../../../config/constants.js';
import { AUTH_ROLES } from '../../../services/auth.roles.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';

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

export const passwordSchema = z
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

export const authUserResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
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
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
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
    currentPassword: z
      .string()
      .min(1, 'Current password is required')
      .max(
        PASSWORD_MAX_LENGTH,
        `Current password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      )
      .openapi({
        format: 'password',
        description: 'Current account password required to confirm this sensitive action.',
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
