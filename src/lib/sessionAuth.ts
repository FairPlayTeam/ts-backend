import { Request, Response, NextFunction } from 'express';
import { validateSession } from '../controllers/sessionController.js';

export interface SessionAuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
  session?: {
    id: string;
    sessionKey: string;
    expiresAt: Date;
  };
}

export const authenticateSession = async (
  req: SessionAuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const sessionKey = authHeader && authHeader.split(' ')[1];

  if (!sessionKey) {
    res.status(401).json({ error: 'Session key required' });
    return;
  }

  try {
    const session = await validateSession(sessionKey);

    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = {
      id: session.user.id,
      email: session.user.email,
      username: session.user.username,
      role: session.user.role,
    };

    req.session = {
      id: session.id,
      sessionKey: session.sessionKey,
      expiresAt: session.expiresAt,
    };

    next();
  } catch (error) {
    console.error('Session authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

export const requireAdmin = (
  req: SessionAuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

export const requireModerator = (
  req: SessionAuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (req.user?.role !== 'moderator' && req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Moderator or admin access required' });
    return;
  }
  next();
};

export const optionalSessionAuthenticate = async (
  req: SessionAuthRequest,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers['authorization'];
    const sessionKey = authHeader && authHeader.split(' ')[1];

    if (sessionKey) {
      const session = await validateSession(sessionKey);

      if (session && session.user) {
        req.user = {
          id: session.user.id,
          email: session.user.email,
          username: session.user.username,
          role: session.user.role,
        };

        req.session = {
          id: session.id,
          sessionKey: session.sessionKey,
          expiresAt: session.expiresAt,
        };
      }
    }
  } catch (error) {
    console.error('Optional session authentication error:', error);
  }

  next();
};

export const requireNotBanned = async (
  req: SessionAuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (req.user.role === 'admin' || req.user.role === 'moderator') {
      return next();
    }

    const { prisma } = await import('../lib/prisma.js');
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { isBanned: true },
    });

    if (user?.isBanned) {
      res.status(403).json({ error: 'Account is banned' });
      return;
    }

    next();
  } catch (err) {
    res.status(500).json({ error: 'Ban check failed' });
  }
};

export const isOwner = (req: SessionAuthRequest, ownerId: string): boolean => {
  return Boolean(req.user && req.user.id === ownerId);
};
