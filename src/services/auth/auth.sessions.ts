import { getSessionExpiresAt, getSessionKeySuffix } from './auth.helpers.js';
import type { AuthDependencies } from './auth.dependencies.js';
import type {
  AuthService,
  Session,
  ListUserSessionsInput,
  UserSessionSummary,
  LogoutAllSessionsInput,
  LogoutOtherSessionsInput,
  LogoutSessionInput,
  CleanupSessionsInput,
} from '../auth.types.js';
import {
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
} from './auth.messages.js';

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
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

type CreateSessionResult = {
  sessionKey: string;
  session: Session;
};

export type SessionService = Pick<
  AuthService,
  | 'validateSession'
  | 'getUserSessions'
  | 'logoutAllSessions'
  | 'logoutOtherSessions'
  | 'logoutSession'
  | 'cleanupSessions'
> & {
  prepareSession(input: PrepareSessionInput): Promise<PrepareSessionResult>;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
};

const UPDATE_INTERVAL_MS = 1000 * 60 * 5;

export const createSessionService = (deps: AuthDependencies): SessionService => {
  const prepareSession = async ({
    ipAddress,
    userAgent,
  }: PrepareSessionInput): Promise<PrepareSessionResult> => {
    const now = deps.clock.now();
    const expiresAt = getSessionExpiresAt(now, deps.config.sessionTtlMs);
    const sessionKey = deps.token.generate();
    const sessionKeyHash = deps.token.hash(sessionKey);

    return {
      now,
      sessionKey,
      sessionData: {
        sessionKey: sessionKeyHash,
        sessionKeySuffix: getSessionKeySuffix(sessionKey),
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        deviceInfo: userAgent ?? null,
        expiresAt,
      },
    };
  };

  const createSession = async ({
    userId,
    ipAddress,
    userAgent,
  }: CreateSessionInput): Promise<CreateSessionResult> => {
    const { now, sessionKey, sessionData } = await prepareSession({ ipAddress, userAgent });

    const session = await deps.prisma.$transaction(async (tx) => {
      const createdSession = await tx.session.create({
        data: {
          ...sessionData,
          userId,
        },
        select: {
          id: true,
          expiresAt: true,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { lastLogin: now },
      });

      return createdSession;
    });

    return { sessionKey, session };
  };

  return {
    prepareSession,
    createSession,

    async validateSession(sessionKey: string) {
      const sessionKeyHash = deps.token.hash(sessionKey);
      const now = deps.clock.now();

      const session = await deps.prisma.session.findUnique({
        where: { sessionKey: sessionKeyHash },
        select: {
          id: true,
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
          expiresAt: session.expiresAt,
        },
      };
    },

    async getUserSessions({
      userId,
      currentSessionId,
    }: ListUserSessionsInput): Promise<{ sessions: UserSessionSummary[]; total: number }> {
      const now = deps.clock.now();

      const sessions = await deps.prisma.session.findMany({
        where: {
          userId,
          isActive: true,
          expiresAt: {
            gt: now,
          },
        },
        select: {
          id: true,
          sessionKeySuffix: true,
          ipAddress: true,
          userAgent: true,
          deviceInfo: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
        },
        orderBy: {
          lastUsedAt: 'desc',
        },
      });

      return {
        sessions: sessions.map((session) => ({
          id: session.id,
          sessionKeySuffix: session.sessionKeySuffix,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          deviceInfo: session.deviceInfo,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          expiresAt: session.expiresAt,
          isCurrent: session.id === currentSessionId,
        })),
        total: sessions.length,
      };
    },

    async logoutAllSessions({
      userId,
    }: LogoutAllSessionsInput): Promise<{ message: string; sessionsLoggedOut: number }> {
      const result = await deps.prisma.session.updateMany({
        where: {
          userId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });

      return {
        message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
        sessionsLoggedOut: result.count,
      };
    },

    async logoutOtherSessions({
      userId,
      currentSessionId,
    }: LogoutOtherSessionsInput): Promise<{ message: string; sessionsLoggedOut: number }> {
      const result = await deps.prisma.session.updateMany({
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
          id: sessionId,
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
