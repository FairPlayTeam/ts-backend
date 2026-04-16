import { Request, Response } from 'express';
import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { isUUID } from '../lib/utils.js';

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_KEY_SUFFIX_LENGTH = 8;
const LAST_USED_AT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const sessionUserSelect = {
  id: true,
  email: true,
  username: true,
  role: true,
  isActive: true,
  isBanned: true,
} satisfies Prisma.UserSelect;

type SessionRecord = Prisma.SessionGetPayload<{
  include: {
    user: {
      select: typeof sessionUserSelect;
    };
  };
}>;

export class SessionValidationUnavailableError extends Error {
  constructor(message = 'Session validation is temporarily unavailable.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionValidationUnavailableError';
  }
}

const generateSessionKey = (): string => {
  const prefix = 'fp_sess';
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `${prefix}_${randomBytes}`;
};

const hashSessionKey = (sessionKey: string): string =>
  crypto.createHash('sha256').update(sessionKey).digest('hex');

const getSessionKeySuffix = (sessionKey: string): string =>
  sessionKey.slice(-SESSION_KEY_SUFFIX_LENGTH);

const isHashedSessionKey = (value: string): boolean =>
  /^[0-9a-f]{64}$/i.test(value);

const shouldRefreshLastUsedAt = (lastUsedAt: Date): boolean =>
  Date.now() - lastUsedAt.getTime() >= LAST_USED_AT_REFRESH_INTERVAL_MS;

const migrateLegacySessionKey = async (
  sessionId: string,
  sessionKeyHash: string,
  sessionKeySuffix: string,
): Promise<void> => {
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        sessionKey: sessionKeyHash,
        sessionKeySuffix,
      },
    });
  } catch (error) {
    console.error('Legacy session migration error:', error);
  }
};

const refreshSessionLastUsedAt = async (sessionId: string): Promise<void> => {
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastUsedAt: new Date() },
    });
  } catch (error) {
    console.error('Session lastUsedAt refresh error:', error);
  }
};

const extractDeviceInfo = (userAgent?: string): string => {
  if (!userAgent) return 'Unknown Device';

  if (userAgent.includes('Mobile') || userAgent.includes('Android')) {
    return 'Mobile Device';
  } else if (userAgent.includes('iPad') || userAgent.includes('Tablet')) {
    return 'Tablet';
  } else if (userAgent.includes('Windows')) {
    return 'Windows PC';
  } else if (userAgent.includes('Macintosh')) {
    return 'Mac';
  } else if (userAgent.includes('Linux')) {
    return 'Linux PC';
  }

  return 'Desktop Browser';
};

const getSingleHeaderValue = (header: string | string[] | undefined): string | undefined => {
  if (typeof header === 'string') {
    return header;
  }

  return header?.[0];
};

const getClientIP = (req: Request): string => {
  if (req.ip) {
    return req.ip;
  }

  const forwarded = getSingleHeaderValue(req.headers['x-forwarded-for']);
  const realIP = getSingleHeaderValue(req.headers['x-real-ip']);

  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  if (realIP) {
    return realIP;
  }

  return req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
};

export const createSession = async (
  userId: string,
  req: Request,
): Promise<{ sessionKey: string; session: SessionRecord }> => {
  const sessionKey = generateSessionKey();
  const sessionKeyHash = hashSessionKey(sessionKey);
  const sessionKeySuffix = getSessionKeySuffix(sessionKey);
  const ipAddress = getClientIP(req);
  const userAgent = req.get('user-agent') ?? undefined;
  const deviceInfo = extractDeviceInfo(userAgent);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const session = await prisma.session.create({
    data: {
      sessionKey: sessionKeyHash,
      sessionKeySuffix,
      userId,
      ipAddress,
      userAgent: userAgent ?? null,
      deviceInfo,
      expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
    },
    include: {
      user: {
        select: sessionUserSelect,
      },
    },
  });

  return { sessionKey, session };
};

export const getUserSessions = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessions = await prisma.session.findMany({
      where: {
        userId: req.user.id,
        isActive: true,
        expiresAt: {
          gt: new Date(),
        },
      },
      select: {
        id: true,
        sessionKeySuffix: true,
        ipAddress: true,
        deviceInfo: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
      orderBy: {
        lastUsedAt: 'desc',
      },
    });

    const maskedSessions = sessions.map((session) => ({
      id: session.id,
      ipAddress: session.ipAddress,
      deviceInfo: session.deviceInfo,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      sessionKey: `****${session.sessionKeySuffix ?? 'unknown'}`,
      isCurrent: session.id === req.session?.id,
    }));

    res.json({
      sessions: maskedSessions,
      total: sessions.length,
    });
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
};

export const logoutSession = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { sessionId } = req.params;

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    if (!isUUID(sessionId)) {
      res.status(400).json({ error: 'Invalid session ID format' });
      return;
    }

    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        userId: req.user.id,
        isActive: true,
      },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await prisma.session.update({
      where: { id: sessionId },
      data: { isActive: false },
    });

    res.json({ message: 'Session logged out successfully' });
  } catch (error) {
    console.error('Logout session error:', error);
    res.status(500).json({ error: 'Failed to logout session' });
  }
};

export const logoutAllOtherSessions = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const authHeader = req.headers.authorization;
    const currentSessionKey = authHeader?.replace('Bearer ', '');

    if (!currentSessionKey) {
      res.status(400).json({ error: 'Current session not found' });
      return;
    }

    const currentSessionKeyHash = hashSessionKey(currentSessionKey);

    const result = await prisma.session.updateMany({
      where: {
        userId: req.user.id,
        isActive: true,
        sessionKey: {
          not: currentSessionKeyHash,
        },
      },
      data: {
        isActive: false,
      },
    });

    res.json({
      message: 'All other sessions logged out successfully',
      sessionsLoggedOut: result.count,
    });
  } catch (error) {
    console.error('Logout all sessions error:', error);
    res.status(500).json({ error: 'Failed to logout all sessions' });
  }
};

export const logoutAllSessions = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await prisma.session.updateMany({
      where: {
        userId: req.user.id,
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });

    res.json({
      message: 'All sessions logged out successfully',
      sessionsLoggedOut: result.count,
    });
  } catch (error) {
    console.error('Logout all sessions error:', error);
    res.status(500).json({ error: 'Failed to logout all sessions' });
  }
};

export const validateSession = async (sessionKey: string): Promise<SessionRecord | null> => {
  const sessionKeyHash = hashSessionKey(sessionKey);

  let session: SessionRecord | null;

  try {
    session = await prisma.session.findUnique({
      where: {
        sessionKey: sessionKeyHash,
      },
      include: {
        user: {
          select: sessionUserSelect,
        },
      },
    });

    if (!session) {
      const legacySession = await prisma.session.findUnique({
        where: {
          sessionKey,
        },
        include: {
          user: {
            select: sessionUserSelect,
          },
        },
      });

      if (legacySession && !isHashedSessionKey(legacySession.sessionKey)) {
        void migrateLegacySessionKey(
          legacySession.id,
          sessionKeyHash,
          getSessionKeySuffix(sessionKey),
        );
        session = legacySession;
      } else {
        session = legacySession;
      }
    }

    if (!session || !session.isActive || session.expiresAt < new Date()) {
      return null;
    }

    if (!session.user.isActive || session.user.isBanned) {
      return null;
    }

    if (shouldRefreshLastUsedAt(session.lastUsedAt)) {
      void refreshSessionLastUsedAt(session.id);
    }

    return session;
  } catch (error) {
    console.error('Validate session error:', error);
    throw new SessionValidationUnavailableError(undefined, {
      cause: error instanceof Error ? error : undefined,
    });
  }
};

const INACTIVE_SESSION_RETENTION_DAYS = 30;

export const cleanupExpiredSessions = async (): Promise<void> => {
    try {
        const retentionCutoff = new Date();
        retentionCutoff.setDate(retentionCutoff.getDate() - INACTIVE_SESSION_RETENTION_DAYS);

        await prisma.session.deleteMany({
            where: {
                OR: [
                    { expiresAt: { lt: new Date() } },
                    {
                        isActive: false,
                        updatedAt: { lt: retentionCutoff },
                    },
                ],
            },
        });
    } catch (error) {
        console.error('Cleanup expired sessions error:', error);
    }
};
