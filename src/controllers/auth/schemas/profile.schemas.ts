import { z } from '../../../docs/zod.js';
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH } from '../../../config/constants.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
} from '../../../services/auth/auth.messages.js';
import { PROFILE_UPDATE_EMPTY_MESSAGE } from '../../../services/auth.errors.js';
import { AUTH_ROLES } from '../../../services/auth.roles.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';
import {
  authSessionResponseSchema,
  authUserProfileResponseSchema,
  authUserResponseSchema,
  responseMessageSchema,
  sessionDeviceInfoResponseSchema,
  sessionIpAddressResponseSchema,
  sessionUserAgentResponseSchema,
} from './shared.schemas.js';

export const currentUserResponseSchema = z
  .object({
    user: authUserProfileResponseSchema,
    session: authSessionResponseSchema,
  })
  .openapi('CurrentUserResponse');

export const deleteAccountResponseSchema = z
  .object({
    message: z
      .enum([DELETE_ACCOUNT_SUCCESS_MESSAGE, DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE])
      .openapi({ example: DELETE_ACCOUNT_SUCCESS_MESSAGE }),
    mediaCleanupQueued: z.number().int().nonnegative().openapi({
      description: 'Number of stored media objects queued for asynchronous deletion.',
      example: 0,
    }),
    externalCleanupQueued: z.number().int().nonnegative().optional().openapi({
      description: 'Number of external resources queued for asynchronous reconciliation.',
      example: 0,
    }),
  })
  .openapi('DeleteAccountResponse');

const userDataExportDateTimeSchema = z.string().datetime();
const nullableUserDataExportDateTimeSchema = userDataExportDateTimeSchema.nullable();

const userDataExportTokenSchema = z.object({
  id: z.string().openapi({ example: 'cmbl7u2ag0000i6c2p5o9h9ta' }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  expiresAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-08T00:00:00.000Z' }),
});

const userDataExportMediaAssetSchema = z.object({
  id: z.string().uuid().openapi({ example: '9c1a78ff-8c35-4b2f-9ae0-289b4cfdbf38' }),
  kind: z.enum(['avatar', 'banner']).openapi({ example: 'avatar' }),
  url: relativeAssetPathSchema.openapi({ example: '/profiles/fairplay_creator/avatar' }),
  mimeType: z.literal('image/webp').openapi({ example: 'image/webp' }),
  sizeBytes: z.number().int().positive().openapi({ example: 18342 }),
  width: z.number().int().positive().openapi({ example: 512 }),
  height: z.number().int().positive().openapi({ example: 512 }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  updatedAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const userDataExportVideoRatingSchema = z.object({
  videoId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  value: z.number().int().min(1).max(5).openapi({ example: 5 }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  updatedAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

export const userDataExportResponseSchema = z
  .object({
    exportedAt: userDataExportDateTimeSchema.openapi({
      example: '2026-01-01T00:00:00.000Z',
    }),
    user: z.object({
      id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
      email: z.string().email().openapi({ example: 'creator@example.com' }),
      username: z.string().openapi({ example: 'fairplay_creator' }),
      displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
      bio: z.string().nullable().openapi({
        example: 'Sharing project updates with my subscribers.',
      }),
      role: z.enum(AUTH_ROLES).openapi({ example: 'user' }),
      isVerified: z.boolean().openapi({ example: true }),
      isBanned: z.boolean().openapi({ example: false }),
      bannedAt: nullableUserDataExportDateTimeSchema.openapi({ example: null }),
      createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
      updatedAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
      lastLogin: nullableUserDataExportDateTimeSchema.openapi({
        example: '2026-01-01T00:00:00.000Z',
      }),
    }),
    mediaAssets: z.array(userDataExportMediaAssetSchema),
    videoRatings: z.array(userDataExportVideoRatingSchema),
    sessions: z.array(
      z.object({
        id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
        sessionKeySuffix: z.string().nullable().openapi({ example: '9a8b7c6d' }),
        ipAddress: sessionIpAddressResponseSchema,
        userAgent: sessionUserAgentResponseSchema,
        deviceInfo: sessionDeviceInfoResponseSchema,
        isActive: z.boolean().openapi({ example: true }),
        isCurrent: z.boolean().openapi({ example: true }),
        createdAt: userDataExportDateTimeSchema.openapi({
          example: '2026-01-01T00:00:00.000Z',
        }),
        updatedAt: userDataExportDateTimeSchema.openapi({
          example: '2026-01-01T00:00:00.000Z',
        }),
        lastUsedAt: userDataExportDateTimeSchema.openapi({
          example: '2026-01-01T00:00:00.000Z',
        }),
        expiresAt: userDataExportDateTimeSchema.openapi({
          example: '2026-01-31T00:00:00.000Z',
        }),
      }),
    ),
    emailVerificationToken: userDataExportTokenSchema.nullable(),
    passwordResetToken: userDataExportTokenSchema.nullable(),
  })
  .openapi('UserDataExportResponse');

export const updateProfileBodySchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, 'Display name must not be empty')
      .max(
        DISPLAY_NAME_MAX_LENGTH,
        `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
      )
      .nullable()
      .optional()
      .openapi({ example: 'FairPlay Creator' }),
    bio: z
      .string()
      .trim()
      .max(BIO_MAX_LENGTH, `Bio must be at most ${BIO_MAX_LENGTH} characters`)
      .nullable()
      .optional()
      .openapi({
        example: 'Sharing project updates with my subscribers.',
      }),
  })
  .strict()
  .refine((body) => body.displayName !== undefined || body.bio !== undefined, {
    message: PROFILE_UPDATE_EMPTY_MESSAGE,
  })
  .openapi('UpdateProfileRequest');

export const updateProfileSchema = z.object({
  body: updateProfileBodySchema,
});

export const updateProfileResponseSchema = z
  .object({
    message: responseMessageSchema(UPDATE_PROFILE_SUCCESS_MESSAGE),
    user: authUserResponseSchema,
  })
  .openapi('UpdateProfileResponse');

export type UpdateProfileRequestBody = z.infer<typeof updateProfileSchema>['body'];
