import { z } from '../../../docs/zod.js';
import {
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
} from '../../../services/auth/auth.messages.js';
import {
  responseMessageSchema,
  sessionDeviceInfoResponseSchema,
  sessionIpAddressResponseSchema,
  sessionUserAgentResponseSchema,
} from './shared.schemas.js';

export const LOGOUT_SESSION_ID_INVALID_MESSAGE = 'Session id must be a valid UUID';
export const USER_SESSIONS_CURSOR_PAIR_MESSAGE =
  'cursorLastUsedAt and cursorId must be provided together';

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

export const userSessionsResponseSchema = z
  .object({
    sessions: z.array(
      z.object({
        id: z.string().uuid().openapi({ example: '0d4e55cb-c278-4d74-a192-bf7c10888c7a' }),
        sessionKeySuffix: z.string().nullable().openapi({ example: '9a8b7c6d' }),
        ipAddress: sessionIpAddressResponseSchema,
        userAgent: sessionUserAgentResponseSchema,
        deviceInfo: sessionDeviceInfoResponseSchema,
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

export type UserSessionsQuery = z.infer<typeof userSessionsSchema>['query'];
export type LogoutSessionParams = z.infer<typeof logoutSessionSchema>['params'];
