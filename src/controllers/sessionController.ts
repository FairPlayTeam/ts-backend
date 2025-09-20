import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { isUUID } from '../lib/utils.js';

const generateSessionKey = (): string => {
  const prefix = 'fp_sess';
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `${prefix}_${randomBytes}`;
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

const getClientIP = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'] as string;
  const realIP = req.headers['x-real-ip'] as string;

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
): Promise<{ sessionKey: string; session: any }> => {
  const sessionKey = generateSessionKey();
  const ipAddress = getClientIP(req);
  const userAgent = req.headers['user-agent'];
  const deviceInfo = extractDeviceInfo(userAgent);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const session = await prisma.session.create({
    data: {
      sessionKey,
      userId,
      ipAddress,
      userAgent: userAgent || null,
      deviceInfo,
      expiresAt,
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
        },
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
        sessionKey: true,
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
      ...session,
      sessionKey: `****${session.sessionKey.slice(-8)}`,
      isCurrent: req.headers.authorization?.includes(
        session.sessionKey.slice(-8),
      ),
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

    const result = await prisma.session.updateMany({
      where: {
        userId: req.user.id,
        isActive: true,
        sessionKey: {
          not: currentSessionKey,
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

export const validateSession = async (sessionKey: string): Promise<any> => {
  try {
    const session = await prisma.session.findUnique({
      where: {
        sessionKey,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            role: true,
            isActive: true,
            isBanned: true,
          },
        },
      },
    });

    if (!session || !session.isActive || session.expiresAt < new Date()) {
      return null;
    }

    if (!session.user.isActive || session.user.isBanned) {
      return null;
    }

    await prisma.session.update({
      where: { sessionKey },
      data: { lastUsedAt: new Date() },
    });

    return session;
  } catch (error) {
    console.error('Validate session error:', error);
    return null;
  }
};

export const cleanupExpiredSessions = async (): Promise<void> => {
  try {
    await prisma.session.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { isActive: false }],
      },
    });
  } catch (error) {
    console.error('Cleanup expired sessions error:', error);
  }
};
