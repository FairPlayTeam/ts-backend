import { AccountBannedError, InvalidEmailVerificationTokenError } from '../auth.errors.js';
import type { AuthService, VerifyEmailInput, ResendVerificationInput } from '../auth.types.js';
import {
  normalizeEmail,
  getEmailVerificationExpiresAt,
  isExpectedMailerError,
} from './auth.helpers.js';
import type { AuthDependencies } from './auth.dependencies.js';
import type { SessionService } from './auth.sessions.js';
import {
  VERIFY_EMAIL_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_SUCCESS_MESSAGE,
} from './auth.messages.js';

type VerificationService = Pick<AuthService, 'verifyEmail' | 'resendVerification'>;

export const createVerificationService = (
  deps: AuthDependencies,
  sessionService: SessionService,
): VerificationService => ({
  async verifyEmail({ token, ipAddress, userAgent }: VerifyEmailInput) {
    const tokenHash = deps.token.hash(token);
    const { now, sessionKey, sessionData } = await sessionService.prepareSession({
      ipAddress,
      userAgent,
    });

    const record = await deps.prisma.emailVerificationToken.findUnique({
      where: { token: tokenHash },
      include: {
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

    if (!record) {
      throw new InvalidEmailVerificationTokenError();
    }

    if (record.expiresAt <= now) {
      await deps.prisma.emailVerificationToken.deleteMany({ where: { token: tokenHash } });
      throw new InvalidEmailVerificationTokenError();
    }

    if (record.user.isBanned) {
      throw new AccountBannedError();
    }

    const session = await deps.prisma.$transaction(async (tx) => {
      const consumedToken = await tx.emailVerificationToken.deleteMany({
        where: { token: tokenHash },
      });

      if (consumedToken.count !== 1) {
        throw new InvalidEmailVerificationTokenError();
      }

      await tx.user.update({
        where: { id: record.userId },
        data: { isVerified: true, lastLogin: now },
      });

      return tx.session.create({
        data: {
          ...sessionData,
          userId: record.userId,
        },
        select: {
          id: true,
          expiresAt: true,
        },
      });
    });

    return {
      message: VERIFY_EMAIL_SUCCESS_MESSAGE,
      user: {
        id: record.user.id,
        email: record.user.email,
        username: record.user.username,
        displayName: record.user.displayName,
        bio: record.user.bio,
        role: record.user.role,
      },
      sessionKey,
      session,
    };
  },

  async resendVerification({ email }: ResendVerificationInput) {
    const emailNorm = normalizeEmail(email);
    const token = deps.token.generate();
    const tokenHash = deps.token.hash(token);
    const expiresAt = getEmailVerificationExpiresAt(
      deps.clock.now(),
      deps.config.emailVerificationTokenTtlMs,
    );

    // TRADEOFF: we invalidate the old token before sending the email.
    // If SMTP delivery fails, the user must request another verification email.
    const user = await deps.prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { email: emailNorm },
        select: { id: true, email: true, isVerified: true },
      });

      if (!existingUser || existingUser.isVerified) {
        return null;
      }

      await tx.emailVerificationToken.upsert({
        where: { userId: existingUser.id },
        update: {
          token: tokenHash,
          expiresAt,
        },
        create: {
          userId: existingUser.id,
          token: tokenHash,
          expiresAt,
        },
      });

      return { email: existingUser.email };
    });

    if (user) {
      try {
        await deps.mailer.sendVerificationEmail(user.email, token);
      } catch (err) {
        if (isExpectedMailerError(err)) {
          deps.logger.warn({ err }, 'Verification email could not be sent after resend request');
        } else {
          throw err;
        }
      }
    }

    return {
      message: RESEND_VERIFICATION_SUCCESS_MESSAGE,
    };
  },
});
