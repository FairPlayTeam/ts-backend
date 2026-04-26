import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createSession } from './sessionController.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { getProxiedAssetUrl } from '../lib/utils.js';
import {
  assertMailerConfigured,
  MailerConfigurationError,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../lib/mailer.js';

const EMAIL_DELIVERY_UNAVAILABLE_RESPONSE = {
  error: 'Email delivery is temporarily unavailable. Please try again later.',
};
const PASSWORD_RESET_REQUEST_GENERIC_RESPONSE = {
  message: 'If this email exists and is eligible for password reset, a reset link has been sent.',
};
const INVALID_PASSWORD_RESET_RESPONSE = {
  error: 'Invalid or expired password reset link.',
};
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 1000 * 60 * 60 * 24;
const PASSWORD_RESET_TOKEN_TTL_MS = 1000 * 60 * 60;

const respondWhenMailerUnavailable = (
  res: Response,
  error: unknown,
): boolean => {
  if (error instanceof MailerConfigurationError) {
    res.status(503).json(EMAIL_DELIVERY_UNAVAILABLE_RESPONSE);
    return true;
  }

  return false;
};

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function getExpiryDate(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}

function getBcryptRounds(): number {
  return Number(process.env.BCRYPT_ROUNDS ?? 12);
}

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, username, password } = req.body;
    assertMailerConfigured();

    const usernameNorm = String(username).trim().toLowerCase();
    const emailNorm = String(email).trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, getBcryptRounds());

    try {
      const user = await prisma.user.create({
        data: {
          email: emailNorm,
          username: usernameNorm,
          passwordHash: hashedPassword,
        },
        select: { id: true, email: true, username: true, role: true },
      });

      const token = generateToken();
      const tokenHash = hashToken(token);

      await prisma.$transaction([
        prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
        prisma.emailVerificationToken.create({
          data: {
            userId: user.id,
            token: tokenHash,
            expiresAt: getExpiryDate(EMAIL_VERIFICATION_TOKEN_TTL_MS),
          },
        }),
      ]);

      try {
        await sendVerificationEmail(user.email, token);
      } catch (mailErr) {
        console.error('Verification email failed after registration:', mailErr);

        await prisma.user.delete({ where: { id: user.id } }).catch((cleanupError) => {
          console.error(
            `Failed to rollback user ${user.id} after verification email failure:`,
            cleanupError,
          );
        });

        res.status(503).json(EMAIL_DELIVERY_UNAVAILABLE_RESPONSE);
        return;
      }

      res.status(201).json({
        message: 'Account created. Please verify your email.',
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = err.meta?.target as string[] | undefined;

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
    if (respondWhenMailerUnavailable(res, error)) {
      return;
    }

    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error during registration' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { emailOrUsername, password } = req.body;

    const lookup = String(emailOrUsername).trim();
    const lookupEmail = lookup.toLowerCase();
    const lookupUsername = lookup.toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: lookupEmail }, { username: lookupUsername }],
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        passwordHash: true,
        isActive: true,
        isVerified: true,
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

    if (user.isBanned) {
      res.status(403).json({ error: 'This account has been banned' });
      return;
    }

    if (!user.isActive) {
      res.status(401).json({ error: 'Account is deactivated' });
      return;
    }

    if (!user.isVerified) {
      res.status(403).json({ error: 'Please verify your email address before logging in.' });
      return;
    }

    void prisma.user
      .update({ where: { id: user.id }, data: { lastLogin: new Date() } })
      .catch(() => {});

    const { sessionKey, session } = await createSession(user.id, req);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      sessionKey,
      session: {
        id: session.id,
        expiresAt: session.expiresAt,
        deviceInfo: session.deviceInfo,
        ipAddress: session.ipAddress,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
};

export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Invalid or expired verification link.' });
      return;
    }

    const tokenHash = hashToken(token);

    const record = await prisma.emailVerificationToken.findUnique({
      where: { token: tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            role: true,
            isBanned: true,
            isActive: true,
          },
        },
      },
    });

    if (!record || record.expiresAt < new Date()) {
      if (record) {
        await prisma.emailVerificationToken.delete({ where: { token: tokenHash } });
      }
      res.status(400).json({ error: 'Invalid or expired verification link.' });
      return;
    }

    const { user } = record;

    if (user.isBanned) {
      res.status(403).json({ error: 'This account has been banned.' });
      return;
    }

    if (!user.isActive) {
      res.status(401).json({ error: 'Account is deactivated.' });
      return;
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { isVerified: true },
      }),
      prisma.emailVerificationToken.delete({ where: { token: tokenHash } }),
    ]);

    const { sessionKey, session } = await createSession(record.userId, req);

    res.json({
      message: 'Email successfully verified',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      sessionKey,
      session: { id: session.id, expiresAt: session.expiresAt },
    });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ error: 'Error during verification' });
  }
};

export const resendVerification = async (req: Request, res: Response): Promise<void> => {
  const genericOk = { message: 'If this email exists and is unverified, a new link has been sent.' };

  try {
    const { email } = req.body;
    assertMailerConfigured();

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
    });

    if (!user || user.isVerified) {
      res.json(genericOk);
      return;
    }

    const token = generateToken();
    const tokenHash = hashToken(token);


    await prisma.$transaction([
      prisma.emailVerificationToken.deleteMany({
        where: { userId: user.id },
      }),
      prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          token: tokenHash,
          expiresAt: getExpiryDate(EMAIL_VERIFICATION_TOKEN_TTL_MS),
        },
      }),
    ]);

    try {
      await sendVerificationEmail(user.email, token);
    } catch (mailErr) {
      console.error('Resend verification email failed:', mailErr);
      if (respondWhenMailerUnavailable(res, mailErr)) {
        return;
      }

      res.status(503).json(EMAIL_DELIVERY_UNAVAILABLE_RESPONSE);
      return;
    }

    res.json(genericOk);
  } catch (error) {
    if (respondWhenMailerUnavailable(res, error)) {
      return;
    }

    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const requestPasswordReset = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { email } = req.body;
    assertMailerConfigured();

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: {
        id: true,
        email: true,
        isActive: true,
        isVerified: true,
        isBanned: true,
      },
    });

    if (!user || !user.isActive || user.isBanned || !user.isVerified) {
      res.json(PASSWORD_RESET_REQUEST_GENERIC_RESPONSE);
      return;
    }

    const token = generateToken();
    const tokenHash = hashToken(token);

    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany({
        where: { userId: user.id },
      }),
      prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          token: tokenHash,
          expiresAt: getExpiryDate(PASSWORD_RESET_TOKEN_TTL_MS),
        },
      }),
    ]);

    try {
      await sendPasswordResetEmail(user.email, token);
    } catch (mailErr) {
      console.error('Password reset email failed:', mailErr);
      await prisma.passwordResetToken
        .deleteMany({ where: { userId: user.id } })
        .catch((cleanupError) => {
          console.error(
            `Failed to cleanup password reset tokens for user ${user.id}:`,
            cleanupError,
          );
        });
    }

    res.json(PASSWORD_RESET_REQUEST_GENERIC_RESPONSE);
  } catch (error) {
    if (respondWhenMailerUnavailable(res, error)) {
      return;
    }

    console.error('Request password reset error:', error);
    res
      .status(500)
      .json({ error: 'Internal server error during password reset request' });
  }
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, password } = req.body;
    const tokenHash = hashToken(String(token).trim());

    const record = await prisma.passwordResetToken.findUnique({
      where: { token: tokenHash },
      include: {
        user: {
          select: {
            id: true,
            passwordHash: true,
            isActive: true,
            isBanned: true,
          },
        },
      },
    });

    if (!record || record.expiresAt < new Date()) {
      if (record) {
        await prisma.passwordResetToken.deleteMany({
          where: { userId: record.userId },
        });
      }

      res.status(400).json(INVALID_PASSWORD_RESET_RESPONSE);
      return;
    }

    if (record.user.isBanned) {
      res.status(403).json({ error: 'This account has been banned.' });
      return;
    }

    if (!record.user.isActive) {
      res.status(401).json({ error: 'Account is deactivated.' });
      return;
    }

    const isCurrentPassword = await bcrypt.compare(password, record.user.passwordHash);

    if (isCurrentPassword) {
      res
        .status(400)
        .json({ error: 'New password must be different from the current password.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, getBcryptRounds());

    const sessionsLoggedOut = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash: hashedPassword },
      });

      const revokedSessions = await tx.session.updateMany({
        where: {
          userId: record.userId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });

      await tx.passwordResetToken.deleteMany({
        where: { userId: record.userId },
      });

      return revokedSessions.count;
    });

    res.json({
      message: 'Password has been reset successfully. Please log in with your new password.',
      sessionsLoggedOut,
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error during password reset' });
  }
};

export const getProfile = async (
  req: SessionAuthRequest,
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
        followingCount: true,
        totalViews: true,
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
      avatarUrl: getProxiedAssetUrl(user.id, user.avatarUrl ?? null),
      bannerUrl: getProxiedAssetUrl(user.id, user.bannerUrl ?? null),
      bio: user.bio,
      role: user.role,
      isVerified: user.isVerified,
      followerCount: user.followerCount,
      followingCount: user.followingCount,
      totalViews: user.totalViews.toString(),
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
};
