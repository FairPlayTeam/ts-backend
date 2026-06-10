import { z } from '../docs/zod.js';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../config/constants.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../services/auth/auth.messages.js';
import { AUTH_ROLES } from '../services/auth.roles.js';
import { PROFILE_UPDATE_EMPTY_MESSAGE } from '../services/auth.errors.js';

export const LOGOUT_SESSION_ID_INVALID_MESSAGE = 'Session id must be a valid UUID';
export const USER_SESSIONS_CURSOR_PAIR_MESSAGE =
  'cursorLastUsedAt and cursorId must be provided together';
export const UPDATE_PROFILE_REQUIRED_FIELD_MESSAGE = PROFILE_UPDATE_EMPTY_MESSAGE;

const responseMessageSchema = (example: string) => z.string().openapi({ example });

const emailSchema = z
  .string()
  .trim()
  .email('Invalid email format')
  .max(EMAIL_MAX_LENGTH)
  .transform((v) => v.toLowerCase())
  .openapi({ example: 'creator@example.com' });

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

export const logoutSessionParamsSchema = z
  .object({
    sessionId: z
      .string()
      .uuid(LOGOUT_SESSION_ID_INVALID_MESSAGE)
      .openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  })
  .strict()
  .openapi('LogoutSessionParams');

export const logoutSessionSchema = z.object({
  params: logoutSessionParamsSchema,
});

const authUserResponseSchema = z.object({
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

const authUserProfileResponseSchema = authUserResponseSchema.extend({
  avatarUrl: z.string().url().nullable().openapi({
    example:
      'http://localhost:9000/fairplay-user-media/users/9fdf5/avatar/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
  }),
  bannerUrl: z.string().url().nullable().openapi({
    example:
      'http://localhost:9000/fairplay-user-media/users/9fdf5/banner/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
  }),
});

const authSessionResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  expiresAt: z.string().datetime().openapi({ example: '2026-01-31T00:00:00.000Z' }),
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
  })
  .openapi('DeleteAccountResponse');

const userDataExportDateTimeSchema = z.string().datetime();
const nullableUserDataExportDateTimeSchema = userDataExportDateTimeSchema.nullable();

const userDataExportTokenSchema = z.object({
  id: z.string().openapi({ example: 'cmbl7u2ag0000i6c2p5o9h9ta' }),
  createdAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  expiresAt: userDataExportDateTimeSchema.openapi({ example: '2026-01-08T00:00:00.000Z' }),
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
    sessions: z.array(
      z.object({
        id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
        sessionKeySuffix: z.string().nullable().openapi({ example: '9a8b7c6d' }),
        ipAddress: z.string().nullable().openapi({ example: '127.0.0.1' }),
        userAgent: z.string().nullable().openapi({ example: 'Mozilla/5.0' }),
        deviceInfo: z.string().nullable().openapi({ example: 'Mozilla/5.0' }),
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

export const userSessionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    cursorLastUsedAt: z.string().datetime().optional().openapi({
      example: '2026-01-01T00:00:00.000Z',
    }),
    cursorId: z
      .string()
      .uuid('Cursor session id must be a valid UUID')
      .optional()
      .openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
  })
  .strict()
  .refine((query) => (query.cursorLastUsedAt === undefined) === (query.cursorId === undefined), {
    message: USER_SESSIONS_CURSOR_PAIR_MESSAGE,
  })
  .openapi('UserSessionsQuery');

export const userSessionsSchema = z.object({
  query: userSessionsQuerySchema,
});

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
    token: z
      .string()
      .trim()
      .length(64, 'Reset token must be 64 characters')
      .regex(/^[a-f0-9]+$/i, 'Reset token must be hexadecimal')
      .transform((value) => value.toLowerCase())
      .openapi({
        description: 'Raw reset password token from the frontend verification link.',
        example: 'd9f1f7d7b9d24e5c9f9b6a81a9a2eb1b2c1b0c9e7d6f5a4b3c2d1e0f9a8b7c6d',
      }),
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
    message: UPDATE_PROFILE_REQUIRED_FIELD_MESSAGE,
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

const createUserMediaUploadBodySchema = (fieldName: 'avatar' | 'banner', componentName: string) =>
  z
    .object({
      [fieldName]: z.string().openapi({
        type: 'string',
        format: 'binary',
        description: 'JPEG, PNG, or WebP image file.',
      }),
    })
    .openapi(componentName);

export const uploadAvatarBodySchema = createUserMediaUploadBodySchema(
  'avatar',
  'UploadAvatarRequest',
);

export const uploadBannerBodySchema = createUserMediaUploadBodySchema(
  'banner',
  'UploadBannerRequest',
);

type CreateUserMediaAssetResponseSchemaInput = {
  urlExample: string;
  widthExample: number;
  heightExample: number;
};

const createUserMediaAssetResponseSchema = ({
  urlExample,
  widthExample,
  heightExample,
}: CreateUserMediaAssetResponseSchemaInput) =>
  z.object({
    url: z.string().url().openapi({
      example: urlExample,
    }),
    mimeType: z.literal('image/webp').openapi({ example: 'image/webp' }),
    sizeBytes: z.number().int().positive().openapi({ example: 18342 }),
    width: z.number().int().positive().openapi({ example: widthExample }),
    height: z.number().int().positive().openapi({ example: heightExample }),
    updatedAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  });

const avatarAssetResponseSchema = createUserMediaAssetResponseSchema({
  urlExample:
    'http://localhost:9000/fairplay-user-media/users/9fdf5/avatar/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
  widthExample: 512,
  heightExample: 512,
});

const bannerAssetResponseSchema = createUserMediaAssetResponseSchema({
  urlExample:
    'http://localhost:9000/fairplay-user-media/users/9fdf5/banner/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
  widthExample: 1500,
  heightExample: 500,
});

export const uploadAvatarResponseSchema = z
  .object({
    message: responseMessageSchema(UPLOAD_AVATAR_SUCCESS_MESSAGE),
    avatar: avatarAssetResponseSchema,
  })
  .openapi('UploadAvatarResponse');

export const deleteAvatarResponseSchema = z
  .object({
    message: responseMessageSchema(DELETE_AVATAR_SUCCESS_MESSAGE),
    avatar: z.null().openapi({ example: null }),
  })
  .openapi('DeleteAvatarResponse');

export const uploadBannerResponseSchema = z
  .object({
    message: responseMessageSchema(UPLOAD_BANNER_SUCCESS_MESSAGE),
    banner: bannerAssetResponseSchema,
  })
  .openapi('UploadBannerResponse');

export const deleteBannerResponseSchema = z
  .object({
    message: responseMessageSchema(DELETE_BANNER_SUCCESS_MESSAGE),
    banner: z.null().openapi({ example: null }),
  })
  .openapi('DeleteBannerResponse');

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
    nextCursor: z
      .object({
        lastUsedAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
        id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
      })
      .nullable(),
  })
  .openapi('UserSessionsResponse');

export const logoutAllSessionsResponseSchema = z
  .object({
    message: responseMessageSchema(LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE),
    sessionsLoggedOut: z.number().int().nonnegative().openapi({ example: 3 }),
  })
  .openapi('LogoutAllSessionsResponse');

export const logoutOtherSessionsResponseSchema = z
  .object({
    message: responseMessageSchema(LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE),
    sessionsLoggedOut: z.number().int().nonnegative().openapi({ example: 2 }),
  })
  .openapi('LogoutOtherSessionsResponse');

export const logoutSessionResponseSchema = z
  .object({
    message: responseMessageSchema(LOGOUT_SESSION_SUCCESS_MESSAGE),
    sessionsLoggedOut: z.number().int().nonnegative().openapi({ example: 1 }),
  })
  .openapi('LogoutSessionResponse');

export type RegisterRequestBody = z.infer<typeof registerSchema>['body'];
export type LoginRequestBody = z.infer<typeof loginSchema>['body'];
export type VerifyEmailRequestBody = z.infer<typeof verifyEmailSchema>['body'];
export type ResendVerificationRequestBody = z.infer<typeof resendVerificationSchema>['body'];
export type RequestPasswordResetRequestBody = z.infer<typeof requestPasswordResetSchema>['body'];
export type ResetPasswordRequestBody = z.infer<typeof resetPasswordSchema>['body'];
export type UserSessionsQuery = z.infer<typeof userSessionsSchema>['query'];
export type LogoutSessionParams = z.infer<typeof logoutSessionSchema>['params'];
export type UpdateProfileRequestBody = z.infer<typeof updateProfileSchema>['body'];
