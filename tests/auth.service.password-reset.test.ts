import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import {
  AccountBannedError,
  InvalidPasswordResetTokenError,
  PasswordResetPasswordReuseError,
  PasswordResetStateChangedError,
} from '../src/services/auth.errors.js';
import {
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';
import {
  createPasswordResetConfirmationTestDeps,
  createPasswordResetTestDeps,
  fixedNow,
} from './support/authService.js';
import type { PasswordResetTestUser } from './support/authService.js';

describe('auth service password reset', () => {
  test('requests a password reset for verified users', async () => {
    const { deps, calls } = createPasswordResetTestDeps({
      id: 'user-id',
      email: 'user@example.com',
      isVerified: true,
      isBanned: false,
    });
    const service = createAuthService(deps);

    await expect(
      service.requestPasswordReset({
        email: ' USER@Example.COM ',
      }),
    ).resolves.toEqual({
      message: RESET_PASSWORD_EMAIL_MESSAGE,
    });

    expect(calls.userFindUnique).toEqual({
      where: { email: 'user@example.com' },
      select: {
        id: true,
        email: true,
        isVerified: true,
        isBanned: true,
      },
    });

    expect(calls.passwordResetTokenUpsert).toEqual({
      where: { userId: 'user-id' },
      update: {
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:15:00.000Z'),
      },
      create: {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:15:00.000Z'),
      },
    });

    expect(calls.sentEmail).toEqual({
      email: 'user@example.com',
      token: '123456',
    });
  });

  test('keeps password reset responses generic for ineligible users', async () => {
    const ineligibleUsers: PasswordResetTestUser[] = [
      null,
      {
        id: 'user-id',
        email: 'user@example.com',
        isVerified: false,
        isBanned: false,
      },
      {
        id: 'user-id',
        email: 'user@example.com',
        isVerified: true,
        isBanned: true,
      },
    ];

    for (const user of ineligibleUsers) {
      const { deps, calls } = createPasswordResetTestDeps(user);
      const service = createAuthService(deps);

      await expect(
        service.requestPasswordReset({
          email: 'user@example.com',
        }),
      ).resolves.toEqual({
        message: RESET_PASSWORD_EMAIL_MESSAGE,
      });

      expect(calls.passwordResetTokenUpsert).toBeUndefined();
      expect(calls.sentEmail).toBeUndefined();
    }
  });

  test('cleans up password reset tokens when email delivery fails', async () => {
    const mailerError = new MailerDeliveryError('Email failed');
    const { deps, calls } = createPasswordResetTestDeps(
      {
        id: 'user-id',
        email: 'user@example.com',
        isVerified: true,
        isBanned: false,
      },
      {
        mailer: {
          sendVerificationEmail: async () => undefined,
          sendPasswordResetEmail: async () => {
            throw mailerError;
          },
        },
      },
    );
    const service = createAuthService(deps);

    await expect(
      service.requestPasswordReset({
        email: 'user@example.com',
      }),
    ).resolves.toEqual({
      message: RESET_PASSWORD_EMAIL_MESSAGE,
    });

    expect(calls.warning).toEqual({
      data: { err: mailerError },
      message: 'Password reset email could not be sent after request',
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
  });

  test('resets a password, consumes the code, and revokes active sessions', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
          isVerified: true,
          isBanned: false,
        },
      },
      {
        hasher: {
          compare: async (password: string, hash: string) => {
            calls.comparedPassword = { password, hash };

            return false;
          },
          hash: async () => 'hashed-new-password',
        },
      },
    );
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: ' USER@Example.COM ',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).resolves.toEqual({
      message: RESET_PASSWORD_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });

    expect(calls.passwordResetUserFindUnique).toEqual({
      where: { email: 'user@example.com' },
      select: {
        id: true,
        passwordHash: true,
        isVerified: true,
        isBanned: true,
      },
    });
    expect(calls.passwordResetTokenFindUnique).toEqual({
      where: { userId: 'user-id' },
      select: {
        token: true,
        expiresAt: true,
      },
    });
    expect(calls.comparedPassword).toEqual({
      password: 'NewPassword1!',
      hash: 'hashed-old-password',
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: {
          gt: fixedNow,
        },
      },
    });
    expect(calls.passwordResetCurrentUserFindUnique).toEqual({
      where: { id: 'user-id' },
      select: {
        passwordHash: true,
        isBanned: true,
      },
    });
    expect(calls.userUpdateMany).toEqual({
      where: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
      },
      data: {
        passwordHash: 'hashed-new-password',
      },
    });
    expect(calls.sessionUpdateMany).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
  });

  test('rejects missing password reset code records', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(null);
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toBeUndefined();
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('rejects mismatched password reset codes without consuming the record', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps({
      userId: 'user-id',
      token: 'hashed-code-user-id:654321',
      expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      user: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
        isVerified: true,
        isBanned: false,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toBeUndefined();
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('deletes and rejects expired password reset codes', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps({
      userId: 'user-id',
      token: 'hashed-code-user-id:123456',
      expiresAt: fixedNow,
      user: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
        isVerified: true,
        isBanned: false,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: { userId: 'user-id', token: 'hashed-code-user-id:123456' },
    });
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('rejects password reset when the code expires before transaction consumption', async () => {
    const consumedAt = new Date('2026-01-01T00:00:02.000Z');
    let nowCalls = 0;
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
          isVerified: true,
          isBanned: false,
        },
      },
      {
        clock: {
          now: () => (nowCalls++ === 0 ? fixedNow : consumedAt),
        },
        hasher: {
          compare: async (password: string, hash: string) => {
            calls.comparedPassword = { password, hash };

            return false;
          },
          hash: async () => 'hashed-new-password',
        },
      },
      { consumeCount: 0 },
    );
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: {
          gt: consumedAt,
        },
      },
    });
    expect(calls.userUpdateMany).toBeUndefined();
    expect(calls.sessionUpdateMany).toBeUndefined();
  });

  test('rejects password reset for banned users', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps({
      userId: 'user-id',
      token: 'hashed-code-user-id:123456',
      expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      user: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
        isVerified: true,
        isBanned: true,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(AccountBannedError);

    expect(calls.passwordResetTokenDeleteMany).toBeUndefined();
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('rejects password reset when the new password matches the current password', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps({
      userId: 'user-id',
      token: 'hashed-code-user-id:123456',
      expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      user: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
        isVerified: true,
        isBanned: false,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(PasswordResetPasswordReuseError);

    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-old-password',
    });
    expect(calls.passwordResetTokenDeleteMany).toBeUndefined();
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('rejects password reset when the password changed between lookup and transaction', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
          isVerified: true,
          isBanned: false,
        },
      },
      {
        hasher: {
          compare: async (password: string, hash: string) => {
            calls.comparedPassword = { password, hash };

            return hash === 'hashed-current-password';
          },
          hash: async () => 'hashed-new-password',
        },
      },
      { currentPasswordHash: 'hashed-current-password' },
    );
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(PasswordResetStateChangedError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: {
          gt: fixedNow,
        },
      },
    });
    expect(calls.comparedPassword).toEqual({
      password: 'NewPassword1!',
      hash: 'hashed-old-password',
    });
    expect(calls.userUpdateMany).toBeUndefined();
    expect(calls.sessionUpdateMany).toBeUndefined();
  });

  test('rejects password reset when the user password changes before the guarded update', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
          isVerified: true,
          isBanned: false,
        },
      },
      {
        hasher: {
          compare: async (password: string, hash: string) => {
            calls.comparedPassword = { password, hash };

            return false;
          },
          hash: async () => 'hashed-new-password',
        },
      },
      { updateUserCount: 0 },
    );
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(PasswordResetStateChangedError);

    expect(calls.userUpdateMany).toEqual({
      where: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
      },
      data: {
        passwordHash: 'hashed-new-password',
      },
    });
    expect(calls.sessionUpdateMany).toBeUndefined();
  });

  test('rejects already consumed password reset codes inside the transaction', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
          isVerified: true,
          isBanned: false,
        },
      },
      {
        hasher: {
          compare: async () => false,
          hash: async () => 'hashed-new-password',
        },
      },
      { consumeCount: 0 },
    );
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: {
          gt: fixedNow,
        },
      },
    });
    expect(calls.userUpdateMany).toBeUndefined();
    expect(calls.sessionUpdateMany).toBeUndefined();
  });
});
