import { getSessionExpiresAt, getSessionKeySuffix } from '../helpers.js';
import type { AuthDependencies } from '../dependencies.js';
import {
  SESSION_DEVICE_INFO_MAX_LENGTH,
  SESSION_IP_ADDRESS_MAX_LENGTH,
  SESSION_USER_AGENT_MAX_LENGTH,
} from '../../../config/constants.js';
import type { AuthMaintenancePort } from '../maintenance/types.js';
import type {
  AuthSessionManagementPort,
  AuthSessionValidationPort,
  AuthUser,
  CleanupSessionsInput,
  ListUserSessionsInput,
  ListUserSessionsResult,
  LogoutAllSessionsInput,
  LogoutOtherSessionsInput,
  LogoutSessionInput,
  Session,
} from './types.js';
import {
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
} from '../messages.js';
import {
  lockAuthenticatedUser,
  reauthenticateSensitiveAction,
} from '../credentials/reauthentication.js';
import { EmailNotVerifiedError } from '../errors.js';

type PrepareSessionInput = {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

type PrepareSessionResult = {
  now: Date;
  sessionKey: string;
  sessionData: {
    sessionKey: string;
    sessionKeySuffix: string;
    ipAddress: string | null;
    userAgent: string | null;
    deviceInfo: string | null;
    expiresAt: Date;
  };
};

type CreateSessionInput = {
  userId: string;
  authenticatedPasswordHash: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

type CreateSessionResult = {
  user: AuthUser;
  sessionKey: string;
  session: Session;
};

export type SessionService = Pick<
  AuthSessionValidationPort & AuthSessionManagementPort & AuthMaintenancePort,
  | 'validateSession'
  | 'getUserSessions'
  | 'logoutAllSessions'
  | 'logoutOtherSessions'
  | 'logoutSession'
  | 'cleanupSessions'
> & {
  prepareSession(input: PrepareSessionInput): PrepareSessionResult;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
};

const UPDATE_INTERVAL_MS = 1000 * 60 * 5;
const DEFAULT_USER_SESSIONS_LIMIT = 20;
const MAX_USER_SESSIONS_LIMIT = 100;

const normalizeSessionMetadataValue = (
  value: string | undefined,
  maxLength: number,
): string | null => {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
};

const normalizeUserSessionsLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_USER_SESSIONS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_USER_SESSIONS_LIMIT);
};

export const createSessionService = (deps: AuthDependencies): SessionService => {
  const prepareSession = ({ ipAddress, userAgent }: PrepareSessionInput): PrepareSessionResult => {
    const now = deps.clock.now();
    const expiresAt = getSessionExpiresAt(now, deps.config.sessionTtlMs);
    const sessionKey = deps.token.generate();
    const sessionKeyHash = deps.token.hashOpaqueToken(sessionKey);
    const normalizedUserAgent = normalizeSessionMetadataValue(
      userAgent,
      SESSION_USER_AGENT_MAX_LENGTH,
    );
    const normalizedDeviceInfo = normalizeSessionMetadataValue(
      userAgent,
      SESSION_DEVICE_INFO_MAX_LENGTH,
    );

    return {
      now,
      sessionKey,
      sessionData: {
        sessionKey: sessionKeyHash,
        sessionKeySuffix: getSessionKeySuffix(sessionKey),
        ipAddress: normalizeSessionMetadataValue(ipAddress, SESSION_IP_ADDRESS_MAX_LENGTH),
        userAgent: normalizedUserAgent,
        deviceInfo: normalizedDeviceInfo,
        expiresAt,
      },
    };
  };

  const createSession = async ({
    userId,
    authenticatedPasswordHash,
    ipAddress,
    userAgent,
  }: CreateSessionInput): Promise<CreateSessionResult> => {
    const { now, sessionKey, sessionData } = prepareSession({ ipAddress, userAgent });

    const result = await deps.prisma.$transaction(async (tx) => {
      // Serialize before inserting: reset/ban update this row before revoking sessions.
      const currentUser = await lockAuthenticatedUser(tx, userId, authenticatedPasswordHash);
      if (!currentUser.isVerified) {
        throw new EmailNotVerifiedError();
      }

      const createdSession = await tx.session.create({
        data: {
          ...sessionData,
          userId,
        },
        select: {
          id: true,
          publicId: true,
          expiresAt: true,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { lastLogin: now },
      });

      return {
        session: createdSession,
        user: {
          id: currentUser.id,
          email: currentUser.email,
          username: currentUser.username,
          displayName: currentUser.displayName,
          bio: currentUser.bio,
          role: currentUser.role,
        },
      };
    });

    return { sessionKey, ...result };
  };

  return {
    prepareSession,
    createSession,

    async validateSession(sessionKey: string) {
      const sessionKeyHash = deps.token.hashOpaqueToken(sessionKey);
      const now = deps.clock.now();

      const session = await deps.prisma.session.findUnique({
        where: { sessionKey: sessionKeyHash },
        select: {
          id: true,
          publicId: true,
          expiresAt: true,
          isActive: true,
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              displayName: true,
              bio: true,
              role: true,
              isBanned: true,
            },
          },
        },
      });

      if (!session || !session.isActive || session.expiresAt <= now || session.user.isBanned) {
        return null;
      }

      await deps.prisma.session.updateMany({
        where: {
          id: session.id,
          lastUsedAt: {
            lt: new Date(now.getTime() - UPDATE_INTERVAL_MS),
          },
        },
        data: {
          lastUsedAt: now,
        },
      });

      return {
        user: {
          id: session.user.id,
          email: session.user.email,
          username: session.user.username,
          displayName: session.user.displayName,
          bio: session.user.bio,
          role: session.user.role,
        },
        session: {
          id: session.id,
          publicId: session.publicId,
          expiresAt: session.expiresAt,
        },
      };
    },

    async getUserSessions({
      userId,
      currentSessionId,
      cursor,
      limit,
    }: ListUserSessionsInput): Promise<ListUserSessionsResult> {
      const now = deps.clock.now();
      const pageSize = normalizeUserSessionsLimit(limit);

      const where = {
        userId,
        isActive: true,
        expiresAt: { gt: now },
        ...(cursor && {
          OR: [
            { lastUsedAt: { lt: cursor.lastUsedAt } },
            { lastUsedAt: cursor.lastUsedAt, publicId: { lt: cursor.id } },
          ],
        }),
      };

      const [queriedSessions, total] = await deps.prisma.$transaction([
        deps.prisma.session.findMany({
          where,
          select: {
            id: true,
            publicId: true,
            sessionKeySuffix: true,
            ipAddress: true,
            userAgent: true,
            deviceInfo: true,
            createdAt: true,
            lastUsedAt: true,
            expiresAt: true,
          },
          orderBy: [{ lastUsedAt: 'desc' }, { publicId: 'desc' }],
          take: pageSize + 1,
        }),
        deps.prisma.session.count({
          where: { userId, isActive: true, expiresAt: { gt: now } },
        }),
      ]);

      const sessions = queriedSessions.slice(0, pageSize);
      const lastSession = sessions.at(-1);
      const nextCursor =
        queriedSessions.length > pageSize && lastSession
          ? { lastUsedAt: lastSession.lastUsedAt, id: lastSession.publicId }
          : null;

      return {
        sessions: sessions.map((session) => {
          const { id: _internalId, publicId, ...publicSession } = session;

          return { ...publicSession, id: publicId, isCurrent: session.id === currentSessionId };
        }),
        total,
        nextCursor,
      };
    },

    async logoutAllSessions({
      userId,
      currentPassword,
    }: LogoutAllSessionsInput): Promise<{ message: string; sessionsLoggedOut: number }> {
      const authenticatedPasswordHash = await reauthenticateSensitiveAction(deps, {
        userId,
        currentPassword,
      });

      const result = await deps.prisma.$transaction(async (tx) => {
        await lockAuthenticatedUser(tx, userId, authenticatedPasswordHash);
        return tx.session.updateMany({
          where: {
            userId,
            isActive: true,
          },
          data: {
            isActive: false,
          },
        });
      });

      return {
        message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
        sessionsLoggedOut: result.count,
      };
    },

    async logoutOtherSessions({
      userId,
      currentSessionId,
      currentPassword,
    }: LogoutOtherSessionsInput): Promise<{ message: string; sessionsLoggedOut: number }> {
      const authenticatedPasswordHash = await reauthenticateSensitiveAction(deps, {
        userId,
        currentPassword,
      });

      const result = await deps.prisma.$transaction(async (tx) => {
        await lockAuthenticatedUser(tx, userId, authenticatedPasswordHash);
        return tx.session.updateMany({
          where: {
            userId,
            isActive: true,
            id: {
              not: currentSessionId,
            },
          },
          data: {
            isActive: false,
          },
        });
      });

      return {
        message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
        sessionsLoggedOut: result.count,
      };
    },

    async logoutSession({
      userId,
      sessionId,
    }: LogoutSessionInput): Promise<{ message: string; sessionsLoggedOut: number }> {
      const result = await deps.prisma.session.updateMany({
        where: {
          publicId: sessionId,
          userId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });

      return {
        message: LOGOUT_SESSION_SUCCESS_MESSAGE,
        sessionsLoggedOut: result.count,
      };
    },

    async cleanupSessions({ expiredBefore, inactiveUpdatedBefore }: CleanupSessionsInput) {
      const result = await deps.prisma.session.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: expiredBefore } },
            {
              isActive: false,
              updatedAt: { lt: inactiveUpdatedBefore },
            },
          ],
        },
      });

      return {
        message: CLEANUP_SESSION_SUCCESS_MESSAGE,
        sessionsDeleted: result.count,
      };
    },
  };
};
