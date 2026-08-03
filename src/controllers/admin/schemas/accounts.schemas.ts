import { z } from '../../../docs/zod.js';
import { BAN_REASON_MAX_LENGTH } from '../../../config/constants.js';
import { AUTH_ROLES } from '../../../services/auth.roles.js';
import {
  BAN_ACCOUNT_SUCCESS_MESSAGE,
  UNBAN_ACCOUNT_SUCCESS_MESSAGE,
  UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE,
} from '../../../services/admin/admin.messages.js';
import { ADMIN_ACCOUNT_BAN_STATUSES } from '../../../services/admin/admin.accountFilters.js';
import { ADMIN_BAN_REASON_REQUIRED_MESSAGE } from '../../../services/admin.errors.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';

export const ADMIN_ACCOUNTS_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorId must be provided together';
const ADMIN_ACCOUNTS_SEARCH_MAX_LENGTH = 254;

export const adminAccountsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    search: z.string().trim().max(ADMIN_ACCOUNTS_SEARCH_MAX_LENGTH).optional().openapi({
      example: 'creator@example.com',
    }),
    banStatus: z.enum(ADMIN_ACCOUNT_BAN_STATUSES).optional().openapi({
      example: 'allUsers',
    }),
    cursorCreatedAt: z.string().datetime().optional().openapi({
      example: '2026-01-01T00:00:00.000Z',
    }),
    cursorId: z
      .string()
      .uuid('Cursor user id must be a valid UUID')
      .optional()
      .openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  })
  .strict()
  .refine((query) => (query.cursorCreatedAt === undefined) === (query.cursorId === undefined), {
    message: ADMIN_ACCOUNTS_CURSOR_PAIR_MESSAGE,
  })
  .openapi('AdminAccountsQuery');

export const adminAccountsSchema = z.object({
  query: adminAccountsQuerySchema,
});

export const adminAccountParamsSchema = z
  .object({
    userId: z
      .string()
      .uuid('User id must be a valid UUID')
      .openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  })
  .strict()
  .openapi('AdminAccountParams');

export const banAdminAccountRequestSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, ADMIN_BAN_REASON_REQUIRED_MESSAGE)
      .max(BAN_REASON_MAX_LENGTH)
      .openapi({
        example: 'Repeated abusive behavior after moderation warnings.',
      }),
  })
  .strict()
  .openapi('BanAdminAccountRequest');

export const banAdminAccountSchema = z.object({
  params: adminAccountParamsSchema,
  body: banAdminAccountRequestSchema,
});

export const unbanAdminAccountSchema = z.object({
  params: adminAccountParamsSchema,
});

export const updateAdminAccountRoleRequestSchema = z
  .object({
    role: z.enum(AUTH_ROLES).openapi({ example: 'moderator' }),
  })
  .strict()
  .openapi('UpdateAdminAccountRoleRequest');

export const updateAdminAccountRoleSchema = z.object({
  params: adminAccountParamsSchema,
  body: updateAdminAccountRoleRequestSchema,
});

const accountDateTimeSchema = z.string().datetime();
const nullableAccountDateTimeSchema = accountDateTimeSchema.nullable();

const adminAccountSummaryResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  email: z.string().email().openapi({ example: 'creator@example.com' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  avatarUrl: relativeAssetPathSchema.nullable().openapi({
    example: '/profiles/fairplay_creator/avatar',
  }),
  createdAt: accountDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  isVerified: z.boolean().openapi({ example: true }),
  isBanned: z.boolean().openapi({ example: false }),
  bannedAt: nullableAccountDateTimeSchema.openapi({ example: null }),
  lastLogin: nullableAccountDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  updatedAt: accountDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  role: z.enum(AUTH_ROLES).openapi({ example: 'user' }),
});

export const adminAccountsResponseSchema = z
  .object({
    accounts: z.array(adminAccountSummaryResponseSchema),
    total: z.number().int().nonnegative().openapi({ example: 42 }),
    nextCursor: z
      .object({
        createdAt: accountDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
        id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
      })
      .nullable(),
  })
  .openapi('AdminAccountsResponse');

const bannedAdminAccountResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  email: z.string().email().openapi({ example: 'creator@example.com' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  role: z.enum(AUTH_ROLES).openapi({ example: 'user' }),
  isBanned: z.boolean().openapi({ example: true }),
  bannedAt: accountDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
  banReason: z.string().max(BAN_REASON_MAX_LENGTH).openapi({
    example: 'Repeated abusive behavior after moderation warnings.',
  }),
});

export const banAdminAccountResponseSchema = z
  .object({
    message: z.literal(BAN_ACCOUNT_SUCCESS_MESSAGE).openapi({
      example: BAN_ACCOUNT_SUCCESS_MESSAGE,
    }),
    account: bannedAdminAccountResponseSchema,
    sessionsRevoked: z.number().int().nonnegative().openapi({ example: 2 }),
    notificationEmailSent: z.boolean().openapi({ example: true }),
  })
  .openapi('BanAdminAccountResponse');

const unbannedAdminAccountResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  email: z.string().email().openapi({ example: 'creator@example.com' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  role: z.enum(AUTH_ROLES).openapi({ example: 'user' }),
  isBanned: z.boolean().openapi({ example: false }),
  bannedAt: nullableAccountDateTimeSchema.openapi({ example: null }),
  banReason: z.string().max(BAN_REASON_MAX_LENGTH).nullable().openapi({ example: null }),
});

export const unbanAdminAccountResponseSchema = z
  .object({
    message: z.literal(UNBAN_ACCOUNT_SUCCESS_MESSAGE).openapi({
      example: UNBAN_ACCOUNT_SUCCESS_MESSAGE,
    }),
    account: unbannedAdminAccountResponseSchema,
  })
  .openapi('UnbanAdminAccountResponse');

const updatedAdminAccountRoleResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  email: z.string().email().openapi({ example: 'creator@example.com' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  role: z.enum(AUTH_ROLES).openapi({ example: 'moderator' }),
  updatedAt: accountDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

export const updateAdminAccountRoleResponseSchema = z
  .object({
    message: z.literal(UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE).openapi({
      example: UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE,
    }),
    account: updatedAdminAccountRoleResponseSchema,
  })
  .openapi('UpdateAdminAccountRoleResponse');

export type AdminAccountsQuery = z.infer<typeof adminAccountsSchema>['query'];
export type BanAdminAccountParams = z.infer<typeof banAdminAccountSchema>['params'];
export type BanAdminAccountBody = z.infer<typeof banAdminAccountSchema>['body'];
export type UnbanAdminAccountParams = z.infer<typeof unbanAdminAccountSchema>['params'];
export type UpdateAdminAccountRoleParams = z.infer<typeof updateAdminAccountRoleSchema>['params'];
export type UpdateAdminAccountRoleBody = z.infer<typeof updateAdminAccountRoleSchema>['body'];
