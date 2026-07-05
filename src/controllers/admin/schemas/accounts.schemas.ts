import { z } from '../../../docs/zod.js';
import { BAN_REASON_MAX_LENGTH } from '../../../config/constants.js';
import { AUTH_ROLES } from '../../../services/auth.roles.js';
import { BAN_ACCOUNT_SUCCESS_MESSAGE } from '../../../services/admin/admin.messages.js';
import { ADMIN_BAN_REASON_REQUIRED_MESSAGE } from '../../../services/admin.errors.js';

export const ADMIN_ACCOUNTS_CURSOR_PAIR_MESSAGE =
  'cursorCreatedAt and cursorId must be provided together';

export const adminAccountsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
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

export const banAdminAccountParamsSchema = z
  .object({
    userId: z
      .string()
      .uuid('User id must be a valid UUID')
      .openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  })
  .strict()
  .openapi('BanAdminAccountParams');

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
  params: banAdminAccountParamsSchema,
  body: banAdminAccountRequestSchema,
});

const accountDateTimeSchema = z.string().datetime();
const nullableAccountDateTimeSchema = accountDateTimeSchema.nullable();

const adminAccountSummaryResponseSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  email: z.string().email().openapi({ example: 'creator@example.com' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  avatarUrl: z.string().url().nullable().openapi({
    example:
      'http://localhost:9000/fairplay-user-media/users/9fdf5/avatar/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
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

export type AdminAccountsQuery = z.infer<typeof adminAccountsSchema>['query'];
export type BanAdminAccountParams = z.infer<typeof banAdminAccountSchema>['params'];
export type BanAdminAccountBody = z.infer<typeof banAdminAccountSchema>['body'];
