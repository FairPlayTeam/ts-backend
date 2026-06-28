import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import {
  AccountBannedError,
  InvalidEmailVerificationTokenError,
} from '../src/services/auth.errors.js';
import {
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';
import { createDefaultAuthPrisma, createTestDeps, fixedNow } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

describe('auth service email verification', () => {
  test('verifies an email code and creates a hashed session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: ' USER@Example.COM ',
        code: '123456',
        ipAddress: '127.0.0.1',
        userAgent: 'bun-test',
      }),
    ).resolves.toEqual({
      message: VERIFY_EMAIL_SUCCESS_MESSAGE,
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
      },
      sessionKey: 'plain-token',
      session: {
        id: 'session-id',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
      },
    });

    expect(calls.userFindUnique).toEqual({
      where: { email: 'user@example.com' },
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

    expect(calls.tokenFindUnique).toEqual({
      where: { userId: 'user-id' },
      select: {
        token: true,
        expiresAt: true,
      },
    });

    expect(calls.userUpdateMany).toEqual({
      where: { id: 'user-id', isBanned: false, isVerified: false },
      data: { isVerified: true, lastLogin: fixedNow },
    });

    expect(calls.tokenDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        token: 'hashed-user-id:123456',
        expiresAt: {
          gt: fixedNow,
        },
      },
    });

    expect(calls.sessionCreate).toEqual({
      data: {
        sessionKey: 'hashed-plain-token',
        sessionKeySuffix: 'in-token',
        userId: 'user-id',
        ipAddress: '127.0.0.1',
        userAgent: 'bun-test',
        deviceInfo: 'bun-test',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
      },
      select: {
        id: true,
        expiresAt: true,
      },
    });
  });

  test('rejects mismatched email verification codes without consuming the record', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        emailVerificationToken: {
          findUnique: async () => ({
            id: 'verification-token-id',
            userId: 'user-id',
            token: 'hashed-user-id:654321',
            expiresAt: new Date('2026-01-01T00:00:01.000Z'),
            createdAt: fixedNow,
          }),
          deleteMany: async () => {
            throw new Error('Should not delete a mismatched verification code');
          },
        },
        $transaction: async () => {
          throw new Error('Should not consume a mismatched verification code');
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: 'user@example.com',
        code: '123456',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);
  });

  test('rejects missing email verification code records', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        emailVerificationToken: {
          findUnique: async () => null,
          deleteMany: async () => {
            throw new Error('Should not delete a missing verification code');
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: 'user@example.com',
        code: '123456',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);
  });

  test('deletes and rejects expired email verification codes', async () => {
    const { deps, calls } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        emailVerificationToken: {
          findUnique: async () => ({
            id: 'verification-token-id',
            userId: 'user-id',
            token: 'hashed-user-id:123456',
            expiresAt: fixedNow,
            createdAt: fixedNow,
          }),
          deleteMany: async (args: unknown) => {
            calls.tokenDeleteMany = args;

            return { count: 1 };
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: 'user@example.com',
        code: '123456',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);

    expect(calls.tokenDeleteMany).toEqual({
      where: { userId: 'user-id', token: 'hashed-user-id:123456' },
    });
  });

  test('rejects already consumed email verification codes cleanly', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        $transaction: async (
          callback: (transaction: {
            emailVerificationToken: { deleteMany(): Promise<{ count: number }> };
            user: { updateMany(): Promise<never> };
            session: { create(): Promise<never> };
          }) => Promise<unknown>,
        ) =>
          callback({
            emailVerificationToken: {
              deleteMany: async () => ({ count: 0 }),
            },
            user: {
              updateMany: async () => {
                throw new Error('Should not update a user for an already consumed code');
              },
            },
            session: {
              create: async () => {
                throw new Error('Should not create a session for an already consumed code');
              },
            },
          }),
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: 'user@example.com',
        code: '123456',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);
  });

  test('rejects email verification when the code expires before transaction consumption', async () => {
    const consumedAt = new Date('2026-01-01T00:00:02.000Z');
    let nowCalls = 0;
    const { deps, calls } = createTestDeps({
      clock: {
        now: () => (nowCalls++ === 0 ? fixedNow : consumedAt),
      },
      prisma: {
        ...createDefaultAuthPrisma(),
        $transaction: async (
          callback: (transaction: {
            emailVerificationToken: { deleteMany(args: unknown): Promise<{ count: number }> };
            user: { updateMany(): Promise<never> };
            session: { create(): Promise<never> };
          }) => Promise<unknown>,
        ) =>
          callback({
            emailVerificationToken: {
              deleteMany: async (args: unknown) => {
                calls.tokenDeleteMany = args;

                return { count: 0 };
              },
            },
            user: {
              updateMany: async () => {
                throw new Error('Should not update a user after an expired code consumption');
              },
            },
            session: {
              create: async () => {
                throw new Error('Should not create a session after an expired code consumption');
              },
            },
          }),
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: 'user@example.com',
        code: '123456',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);

    expect(calls.tokenDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        token: 'hashed-user-id:123456',
        expiresAt: {
          gt: consumedAt,
        },
      },
    });
    expect(calls.userUpdateMany).toBeUndefined();
    expect(calls.sessionCreate).toBeUndefined();
  });

  test('rejects email verification for banned users', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        user: {
          findUnique: async () => ({
            id: 'user-id',
            email: 'user@example.com',
            username: 'fairplay_user',
            displayName: 'Fairplay User',
            bio: null,
            role: 'user',
            isVerified: false,
            isBanned: true,
          }),
        },
        emailVerificationToken: {
          findUnique: async () => ({
            id: 'verification-token-id',
            userId: 'user-id',
            token: 'hashed-user-id:123456',
            expiresAt: new Date('2026-01-01T00:00:01.000Z'),
            createdAt: fixedNow,
          }),
          deleteMany: async () => {
            throw new Error('Should not delete a banned user verification code');
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: 'user@example.com',
        code: '123456',
      }),
    ).rejects.toBeInstanceOf(AccountBannedError);
  });

  test('rejects email verification when the user is banned during code consumption', async () => {
    const { deps, calls } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        $transaction: async (
          callback: (transaction: {
            emailVerificationToken: { deleteMany(args: unknown): Promise<{ count: number }> };
            user: {
              findUnique(args: unknown): Promise<{ isBanned: true }>;
              updateMany(args: unknown): Promise<{ count: number }>;
            };
            session: { create(): Promise<never> };
          }) => Promise<unknown>,
        ) =>
          callback({
            emailVerificationToken: {
              deleteMany: async (args: unknown) => {
                calls.tokenDeleteMany = args;

                return { count: 1 };
              },
            },
            user: {
              updateMany: async (args: unknown) => {
                calls.userUpdateMany = args;

                return { count: 0 };
              },
              findUnique: async (args: unknown) => {
                calls.userFindUnique = args;

                return { isBanned: true };
              },
            },
            session: {
              create: async () => {
                throw new Error('Should not create a session for a banned user');
              },
            },
          }),
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        email: 'user@example.com',
        code: '123456',
      }),
    ).rejects.toBeInstanceOf(AccountBannedError);

    expect(calls.userUpdateMany).toEqual({
      where: { id: 'user-id', isBanned: false, isVerified: false },
      data: { isVerified: true, lastLogin: fixedNow },
    });
    expect(calls.userFindUnique).toEqual({
      where: { id: 'user-id' },
      select: { isBanned: true },
    });
    expect(calls.sessionCreate).toBeUndefined();
  });

  test('resends a verification email for an unverified user', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.resendVerification({
        email: ' USER@Example.COM ',
      }),
    ).resolves.toEqual({
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    });

    expect(calls.userFindUnique).toEqual({
      where: { email: 'user@example.com' },
      select: { id: true, email: true, isVerified: true, isBanned: true },
    });

    expect(calls.tokenUpsert).toEqual({
      where: { userId: 'user-id' },
      update: {
        token: 'hashed-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      },
      create: {
        userId: 'user-id',
        token: 'hashed-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    });

    expect(calls.sentEmail).toEqual({
      email: 'user@example.com',
      token: '123456',
    });
  });

  test('keeps resend verification responses generic for missing users', async () => {
    const calls = {
      sentEmail: undefined as unknown,
    };

    const { deps } = createTestDeps({
      prisma: {
        $transaction: async (
          callback: (transaction: {
            user: { findUnique(): Promise<null> };
            emailVerificationToken: { upsert(): Promise<never> };
          }) => Promise<unknown>,
        ) =>
          callback({
            user: {
              findUnique: async () => null,
            },
            emailVerificationToken: {
              upsert: async () => {
                throw new Error('Should not create a token for missing users');
              },
            },
          }),
      } as unknown as AuthDeps['prisma'],
      mailer: {
        sendVerificationEmail: async (email: string, code: string) => {
          calls.sentEmail = { email, token: code };
        },
        sendPasswordResetEmail: async () => undefined,
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.resendVerification({
        email: 'missing@example.com',
      }),
    ).resolves.toEqual({
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    });

    expect(calls.sentEmail).toBeUndefined();
  });

  test('keeps resend verification responses generic for verified or banned users', async () => {
    const ineligibleUsers = [
      {
        id: 'user-id',
        email: 'user@example.com',
        isVerified: true,
        isBanned: false,
      },
      {
        id: 'user-id',
        email: 'user@example.com',
        isVerified: false,
        isBanned: true,
      },
    ];

    for (const user of ineligibleUsers) {
      const calls = {
        sentEmail: undefined as unknown,
      };

      const { deps } = createTestDeps({
        prisma: {
          $transaction: async (
            callback: (transaction: {
              user: {
                findUnique(): Promise<typeof user>;
              };
              emailVerificationToken: { upsert(): Promise<never> };
            }) => Promise<unknown>,
          ) =>
            callback({
              user: {
                findUnique: async () => user,
              },
              emailVerificationToken: {
                upsert: async () => {
                  throw new Error('Should not rotate a token for ineligible users');
                },
              },
            }),
        } as unknown as AuthDeps['prisma'],
        mailer: {
          sendVerificationEmail: async (email: string, code: string) => {
            calls.sentEmail = { email, token: code };
          },
          sendPasswordResetEmail: async () => undefined,
        },
      });

      const service = createAuthService(deps);

      await expect(
        service.resendVerification({
          email: 'user@example.com',
        }),
      ).resolves.toEqual({
        message: RESEND_VERIFICATION_EMAIL_MESSAGE,
      });

      expect(calls.sentEmail).toBeUndefined();
    }
  });

  test('keeps resend verification accepted when email delivery fails', async () => {
    const mailerError = new MailerDeliveryError('Email failed');
    const { deps, calls } = createTestDeps({
      mailer: {
        sendVerificationEmail: async () => {
          throw mailerError;
        },
        sendPasswordResetEmail: async () => undefined,
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.resendVerification({
        email: 'user@example.com',
      }),
    ).resolves.toEqual({
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    });

    expect(calls.warning).toEqual({
      data: { err: mailerError },
      message: 'Verification email could not be sent after resend request',
    });
    expect(calls.tokenDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
  });
});
