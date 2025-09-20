import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { generateToken, AuthRequest } from '../lib/auth.js';

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      res
        .status(400)
        .json({ error: 'Email, username, and password are required' });
      return;
    }

    if (password.length < 6) {
      res
        .status(400)
        .json({ error: 'Password must be at least 6 characters long' });
      return;
    }
    const emailNorm = String(email).trim().toLowerCase();
    const saltRounds = Number(process.env.BCRYPT_ROUNDS || 12);
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    try {
      const user = await prisma.user.create({
        data: {
          email: emailNorm,
          username: String(username).trim(),
          passwordHash: hashedPassword,
        },
        select: { id: true, email: true, username: true, role: true },
      });

      const token = generateToken(user.id);

      res.status(201).json({
        message: 'User registered successfully',
        user,
        token,
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = (err as any)?.meta?.target as string[] | undefined;
        if (Array.isArray(target) && target.includes('email')) {
          res.status(409).json({ error: 'User with this email already exists' });
          return;
        }
        if (Array.isArray(target) && target.includes('username')) {
          res.status(409).json({ error: 'Username already taken' });
          return;
        }
        res.status(409).json({ error: 'Email or username already exists' });
        return;
      }
      throw err;
    }
  } catch (error) {
    console.error('Registration error:', error);
    res
      .status(500)
      .json({ error: 'Internal server error during registration' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      res
        .status(400)
        .json({ error: 'Email/username and password are required' });
      return;
    }

    const lookup = String(emailOrUsername).trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: lookup.toLowerCase() }, { username: lookup }],
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        passwordHash: true,
        isActive: true,
        isBanned: true,
      },
    });

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!user.isActive) {
      res.status(401).json({ error: 'Account is deactivated' });
      return;
    }

    if (user.isBanned) {
      res.status(403).json({ error: 'This account has been banned' });
      return;
    }

    void prisma.user
      .update({ where: { id: user.id }, data: { lastLogin: new Date() } })
      .catch(() => {});

    const token = generateToken(user.id);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
};

export const getProfile = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bannerUrl: true,
        bio: true,
        role: true,
        isVerified: true,
        followerCount: true,
        totalViews: true,
        totalEarnings: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      bio: user.bio,
      role: user.role,
      isVerified: user.isVerified,
      followerCount: user.followerCount,
      totalViews: (user as any).totalViews?.toString?.() ?? '0',
      totalEarnings: user.totalEarnings,
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
};
