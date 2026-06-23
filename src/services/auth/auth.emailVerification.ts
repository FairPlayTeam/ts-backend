import { AccountBannedError, InvalidEmailVerificationTokenError } from '../auth.errors.js';
import type { AuthService, VerifyEmailInput, ResendVerificationInput } from '../auth.types.js';
import {
  getEmailVerificationCodeSecret,
  normalizeEmail,
  getEmailVerificationExpiresAt,
  handleExpectedMailerError,
} from './auth.helpers.js';
import type { AuthDependencies } from './auth.dependencies.js';
import type { SessionService } from './auth.sessions.js';
import {
  VERIFY_EMAIL_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
} from './auth.messages.js';

type VerificationService = Pick<AuthService, 'verifyEmail' | 'resendVerification'>;

export const createVerificationService = (
  deps: AuthDependencies,
  sessionService: SessionService,
): VerificationService => ({
  async verifyEmail({ email, code, ipAddress, userAgent }: VerifyEmailInput) {
    const emailNorm = normalizeEmail(email);
    const codeNorm = code.trim();
    const { now, sessionKey, sessionData } = sessionService.prepareSession({
      ipAddress,
      userAgent,
    });

    const user = await deps.prisma.user.findUnique({
      where: { email: emailNorm },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
        isVerified: true,
        isBanned: true,
      },
    });

    if (!user || user.isVerified) {
      throw new InvalidEmailVerificationTokenError();
    }

    const codeHash = deps.token.hash(getEmailVerificationCodeSecret(user.id, codeNorm));
    const record = await deps.prisma.emailVerificationToken.findUnique({
      where: { userId: user.id },
      select: {
        token: true,
        expiresAt: true,
      },
    });

    if (!record || record.token !== codeHash) {
      throw new InvalidEmailVerificationTokenError();
    }

    if (record.expiresAt <= now) {
      await deps.prisma.emailVerificationToken.deleteMany({
        where: { userId: user.id, token: codeHash },
      });
      throw new InvalidEmailVerificationTokenError();
    }

    if (user.isBanned) {
      throw new AccountBannedError();
    }

    const session = await deps.prisma.$transaction(async (tx) => {
      const consumedAt = deps.clock.now();
      const consumedToken = await tx.emailVerificationToken.deleteMany({
        where: {
          userId: user.id,
          token: codeHash,
          expiresAt: {
            gt: consumedAt,
          },
        },
      });

      if (consumedToken.count !== 1) {
        throw new InvalidEmailVerificationTokenError();
      }

      const updatedUser = await tx.user.updateMany({
        where: { id: user.id, isBanned: false, isVerified: false },
        data: { isVerified: true, lastLogin: now },
      });

      if (updatedUser.count !== 1) {
        const currentUser = await tx.user.findUnique({
          where: { id: user.id },
          select: { isBanned: true },
        });

        if (currentUser?.isBanned) {
          throw new AccountBannedError();
        }

        throw new InvalidEmailVerificationTokenError();
      }

      return tx.session.create({
        data: {
          ...sessionData,
          userId: user.id,
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
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        role: user.role,
      },
      sessionKey,
      session,
    };
  },

  async resendVerification({ email }: ResendVerificationInput) {
    const emailNorm = normalizeEmail(email);
    const code = deps.token.generateSixDigitCode();
    const expiresAt = getEmailVerificationExpiresAt(
      deps.clock.now(),
      deps.config.emailVerificationTokenTtlMs,
    );

    const user = await deps.prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { email: emailNorm },
        select: { id: true, email: true, isVerified: true, isBanned: true },
      });

      if (!existingUser || existingUser.isVerified || existingUser.isBanned) {
        return null;
      }

      const codeHash = deps.token.hash(getEmailVerificationCodeSecret(existingUser.id, code));

      await tx.emailVerificationToken.upsert({
        where: { userId: existingUser.id },
        update: {
          token: codeHash,
          expiresAt,
        },
        create: {
          userId: existingUser.id,
          token: codeHash,
          expiresAt,
        },
      });

      return { id: existingUser.id, email: existingUser.email };
    });

    if (user) {
      try {
        await deps.mailer.sendVerificationEmail(user.email, code);
      } catch (err) {
        await handleExpectedMailerError({
          err,
          logger: deps.logger,
          warningMessage: 'Verification email could not be sent after resend request',
          cleanup: {
            run: () =>
              deps.prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
            warningMessage: `Failed to cleanup email verification token for user ${user.id}`,
          },
        });
      }
    }

    return {
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    };
  },
});
