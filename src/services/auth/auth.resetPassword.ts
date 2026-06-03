import {
  AccountBannedError,
  InvalidPasswordResetTokenError,
  PasswordResetPasswordReuseError,
  PasswordResetStateChangedError,
} from '../auth.errors.js';
import type { AuthService, RequestPasswordResetInput, ResetPasswordInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import {
  getPasswordResetExpiresAt,
  handleExpectedMailerError,
  normalizeEmail,
} from './auth.helpers.js';
import { RESET_PASSWORD_EMAIL_MESSAGE, RESET_PASSWORD_SUCCESS_MESSAGE } from './auth.messages.js';

type ResetPasswordService = Pick<AuthService, 'requestPasswordReset' | 'resetPassword'>;

export const createResetPasswordService = (deps: AuthDependencies): ResetPasswordService => ({
  async requestPasswordReset({ email }: RequestPasswordResetInput) {
    const normalizedEmail = normalizeEmail(email);
    const token = deps.token.generate();
    const tokenHash = deps.token.hash(token);
    const expiresAt = getPasswordResetExpiresAt(
      deps.clock.now(),
      deps.config.passwordResetTokenTtlMs,
    );

    const user = await deps.prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { email: normalizedEmail },
        select: {
          id: true,
          email: true,
          isVerified: true,
          isBanned: true,
        },
      });

      if (!existingUser || !existingUser.isVerified || existingUser.isBanned) {
        return null;
      }

      await tx.passwordResetToken.upsert({
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

      return { id: existingUser.id, email: existingUser.email };
    });

    if (user) {
      try {
        await deps.mailer.sendPasswordResetEmail(user.email, token);
      } catch (err) {
        await handleExpectedMailerError({
          err,
          logger: deps.logger,
          warningMessage: 'Password reset email could not be sent after request',
          cleanup: {
            run: () => deps.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
            warningMessage: `Failed to cleanup password reset token for user ${user.id}`,
          },
        });
      }
    }

    return { message: RESET_PASSWORD_EMAIL_MESSAGE };
  },

  async resetPassword({ token, password }: ResetPasswordInput) {
    const tokenHash = deps.token.hash(String(token).trim());
    const now = deps.clock.now();

    const record = await deps.prisma.passwordResetToken.findUnique({
      where: { token: tokenHash },
      include: {
        user: {
          select: {
            id: true,
            passwordHash: true,
            isBanned: true,
          },
        },
      },
    });

    if (!record) {
      throw new InvalidPasswordResetTokenError();
    }

    if (record.expiresAt <= now) {
      await deps.prisma.passwordResetToken.deleteMany({
        where: { token: tokenHash },
      });

      throw new InvalidPasswordResetTokenError();
    }

    if (record.user.isBanned) {
      throw new AccountBannedError();
    }

    const isCurrentPassword = await deps.hasher.compare(password, record.user.passwordHash);

    if (isCurrentPassword) {
      throw new PasswordResetPasswordReuseError();
    }

    const hashedPassword = await deps.hasher.hash(password, deps.config.bcryptRounds);

    const sessionsLoggedOut = await deps.prisma.$transaction(async (tx) => {
      const consumedAt = deps.clock.now();
      const consumed = await tx.passwordResetToken.deleteMany({
        where: {
          token: tokenHash,
          expiresAt: {
            gt: consumedAt,
          },
        },
      });

      if (consumed.count !== 1) {
        throw new InvalidPasswordResetTokenError();
      }

      const currentUser = await tx.user.findUnique({
        where: { id: record.userId },
        select: {
          passwordHash: true,
          isBanned: true,
        },
      });

      if (!currentUser) {
        throw new InvalidPasswordResetTokenError();
      }

      if (currentUser.isBanned) {
        throw new AccountBannedError();
      }

      if (currentUser.passwordHash !== record.user.passwordHash) {
        throw new PasswordResetStateChangedError();
      }

      const updatedUser = await tx.user.updateMany({
        where: {
          id: record.userId,
          passwordHash: currentUser.passwordHash,
        },
        data: {
          passwordHash: hashedPassword,
        },
      });

      if (updatedUser.count !== 1) {
        throw new PasswordResetStateChangedError();
      }

      const revokedSessions = await tx.session.updateMany({
        where: {
          userId: record.userId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });

      return revokedSessions.count;
    });

    return {
      message: RESET_PASSWORD_SUCCESS_MESSAGE,
      sessionsLoggedOut,
    };
  },
});
