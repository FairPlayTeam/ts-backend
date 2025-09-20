import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { prisma } from './prisma.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
}

export const authenticateToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ error: 'User not found or inactive' });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

export const requireAdmin = (
  req: AuthRequest,
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
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (req.user?.role !== 'moderator' && req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Moderator or admin access required' });
    return;
  }
  next();
};

export const generateToken = (userId: string): string => {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, {
    expiresIn: '7d',
  });
};

export const getBearerToken = (req: Request): string | null => {
  const header = req.headers['authorization'];
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2) return null;
  if (parts[0] !== 'Bearer') return null;
  return parts[1] || null;
};

export const getUserIdFromReq = (req: Request): string | null => {
  const token = getBearerToken(req);
  if (!token) return null;
  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    return decoded.userId ?? null;
  } catch (_) {
    return null;
  }
};

export const getCurrentUserFromReq = async (req: Request) => {
  const id = getUserIdFromReq(req);
  if (!id) return null;
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    return user ?? null;
  } catch (_) {
    return null;
  }
};

export const optionalAuthenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const user = await getCurrentUserFromReq(req);
    if (user && user.isActive) {
      req.user = {
        id: user.id,
        email: user.email,
        username: user.username,
        role: (user as any).role,
      };
    }
  } catch (_) {}
  next();
};

export const isOwner = (req: AuthRequest, ownerId: string): boolean => {
  return Boolean(req.user && req.user.id === ownerId);
};

export const requireNotBanned = async (
  req: AuthRequest,
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
