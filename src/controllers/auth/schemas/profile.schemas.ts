import { z } from '../../../docs/zod.js';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  VIDEO_COMMENT_MAX_LENGTH,
} from '../../../config/constants.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
} from '../../../services/auth/auth.messages.js';
import { PROFILE_UPDATE_EMPTY_MESSAGE } from '../../../services/auth.errors.js';
import { AUTH_ROLES } from '../../../services/auth.roles.js';
import { VIDEO_LICENSES } from '../../../services/videos/videoLicenses.js';
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

const userDataExportVideoRatingSchema = z.object({
  videoId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  value: z.number().int().min(1).max(5).openapi({ example: 5 }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  updatedAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const userDataExportVideoViewSchema = z.object({
  videoId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  viewedOn: z.string().date().openapi({ example: '2026-01-01' }),
});

const userDataExportCommentSchema = z.object({
  id: z.string().uuid().openapi({ example: '6bdb6ab4-f598-4e1d-a399-0e9c84c96bd7' }),
  videoId: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  content: z
    .string()
    .min(1)
    .max(VIDEO_COMMENT_MAX_LENGTH)
    .nullable()
    .openapi({ example: 'A thoughtful comment.' }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  deletedAt: nullableUserDataExportDateTimeSchema.openapi({ example: null }),
  rootId: z.string().uuid().nullable().openapi({ example: '6bdb6ab4-f598-4e1d-a399-0e9c84c96bd7' }),
  replyingToCommentId: z
    .string()
    .uuid()
    .nullable()
    .openapi({ example: '6bdb6ab4-f598-4e1d-a399-0e9c84c96bd7' }),
});

const userDataExportCommentLikeSchema = z.object({
  commentId: z.string().uuid().openapi({ example: '6bdb6ab4-f598-4e1d-a399-0e9c84c96bd7' }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const userDataExportFollowSchema = z.object({
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'Fairplay Creator' }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const userDataExportVideoSchema = z.object({
  publicId: z.string().openapi({ example: 'AbCdEf123_' }),
  title: z.string().openapi({ example: 'My video' }),
  description: z.string().nullable().openapi({ example: 'A video description.' }),
  tags: z.array(z.string()).openapi({ example: ['travel', 'family'] }),
  license: z.enum(VIDEO_LICENSES).openapi({ example: 'all_rights_reserved' }),
  visibility: z.enum(['public', 'unlisted']).openapi({ example: 'unlisted' }),
  allowComments: z.boolean().openapi({ example: true }),
  processingStatus: z
    .enum(['draft', 'uploading', 'queued', 'processing', 'ready', 'failed'])
    .openapi({ example: 'ready' }),
  moderationStatus: z.enum(['pending', 'approved', 'rejected']).openapi({ example: 'approved' }),
  durationSeconds: z.number().int().positive().nullable().openapi({ example: 120 }),
  width: z.number().int().positive().nullable().openapi({ example: 1920 }),
  height: z.number().int().positive().nullable().openapi({ example: 1080 }),
  viewCount: z.number().int().nonnegative().openapi({ example: 42 }),
  ratingCount: z.number().int().nonnegative().openapi({ example: 5 }),
  commentCount: z.number().int().nonnegative().openapi({ example: 3 }),
  publishedAt: nullableUserDataExportDateTimeSchema.openapi({ example: null }),
  rejectedAt: nullableUserDataExportDateTimeSchema.openapi({ example: null }),
  rejectionReason: z.string().nullable().openapi({ example: null }),
  deletionRequestedAt: nullableUserDataExportDateTimeSchema.openapi({ example: null }),
  deletionReason: z.string().nullable().openapi({ example: null }),
  deletionOrigin: z.enum(['moderator', 'admin']).nullable().openapi({ example: null }),
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
      banReason: z.string().nullable().openapi({ example: null }),
      createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
      updatedAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
      lastLogin: nullableUserDataExportDateTimeSchema.openapi({
        example: '2026-01-01T00:00:00.000Z',
      }),
    }),
    following: z.array(userDataExportFollowSchema),
    followers: z.array(userDataExportFollowSchema),
    videos: z.array(userDataExportVideoSchema),
    videoRatings: z.array(userDataExportVideoRatingSchema),
    videoViews: z.array(userDataExportVideoViewSchema),
    comments: z.array(userDataExportCommentSchema).openapi({
      description:
        'All comments still attributed to the user, including active content and soft-deleted tombstones whose content is null.',
    }),
    commentLikes: z.array(userDataExportCommentLikeSchema),
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
