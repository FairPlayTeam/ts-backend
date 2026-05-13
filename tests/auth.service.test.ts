import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../src/services/auth.service.js';
import { UserAlreadyExistsError } from '../src/services/auth.errors.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';

type AuthDeps = Parameters<typeof createAuthService>[0];

const fixedNow = new Date('2026-01-01T00:00:00.000Z');

function createTestDeps(overrides: Partial<AuthDeps> = {}) {
  const calls = {
    userFindUnique: undefined as unknown,
    userCreate: undefined as unknown,
    tokenCreate: undefined as unknown,
    tokenUpsert: undefined as unknown,
    sentEmail: undefined as unknown,
    warning: undefined as unknown,
  };

  const tx = {
    user: {
      findUnique: async (args: unknown) => {
        calls.userFindUnique = args;

        return {
          id: 'user-id',
          email: 'user@example.com',
          isVerified: false,
        };
      },
      create: async (args: unknown) => {
        calls.userCreate = args;

        return {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          role: 'user',
        };
      },
    },
    emailVerificationToken: {
      create: async (args: unknown) => {
        calls.tokenCreate = args;
      },
      upsert: async (args: unknown) => {
        calls.tokenUpsert = args;
      },
    },
  };

  const deps = {
    prisma: {
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    },
    isUniqueError: () => false,
    hasher: {
      hash: async () => 'hashed-password',
    },
    token: {
      generate: () => 'plain-token',
      hash: (token: string) => `hashed-${token}`,
    },
    mailer: {
      sendVerificationEmail: async (email: string, token: string) => {
        calls.sentEmail = { email, token };
      },
    },
    clock: {
      now: () => fixedNow,
    },
    config: {
      bcryptRounds: 12,
      emailVerificationTokenTtlMs: 1000,
    },
    logger: {
      warn: (data: object, message: string) => {
        calls.warning = { data, message };
      },
    },
    ...overrides,
  } as unknown as AuthDeps;

  return { deps, calls };
}

describe('auth service', () => {
  test('registers a user and sends a verification email', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    const result = await service.register({
      email: ' USER@Example.COM ',
      username: ' FairPlay_User ',
      password: 'Password1!',
    });

    expect(result).toEqual({
      message: 'Account created. Please verify your email.',
    });

    expect(calls.userCreate).toEqual({
      data: {
        email: 'user@example.com',
        username: 'fairplay_user',
        passwordHash: 'hashed-password',
      },
      select: { id: true, email: true, username: true, role: true },
    });

    expect(calls.tokenCreate).toEqual({
      data: {
        userId: 'user-id',
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    });

    expect(calls.sentEmail).toEqual({
      email: 'user@example.com',
      token: 'plain-token',
    });
  });

  test('throws UserAlreadyExistsError on Prisma unique constraint errors', async () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

    const { deps } = createTestDeps({
      isUniqueError: () => true,

      prisma: {
        $transaction: async () => {
          throw prismaError;
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.register({
        email: 'user@example.com',
        username: 'fairplay_user',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
  });

  test('keeps the user registered when verification email delivery fails', async () => {
    const mailerError = new MailerDeliveryError('Email failed');
    const { deps, calls } = createTestDeps({
      mailer: {
        sendVerificationEmail: async () => {
          throw mailerError;
        },
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.register({
        email: 'user@example.com',
        username: 'fairplay_user',
        password: 'Password1!',
      }),
    ).resolves.toEqual({
      message: 'Account created. Please verify your email.',
    });

    expect(calls.warning).toEqual({
      data: { err: mailerError },
      message: 'Verification email could not be sent after registration',
    });
  });

  test('resends a verification email for an unverified user', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.resendVerification({
        email: ' USER@Example.COM ',
      }),
    ).resolves.toEqual({
      message: 'If this email exists and is unverified, a new link has been sent.',
    });

    expect(calls.userFindUnique).toEqual({
      where: { email: 'user@example.com' },
      select: { id: true, email: true, isVerified: true },
    });

    expect(calls.tokenUpsert).toEqual({
      where: { userId: 'user-id' },
      update: {
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      },
      create: {
        userId: 'user-id',
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    });

    expect(calls.sentEmail).toEqual({
      email: 'user@example.com',
      token: 'plain-token',
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
        sendVerificationEmail: async (email: string, token: string) => {
          calls.sentEmail = { email, token };
        },
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.resendVerification({
        email: 'missing@example.com',
      }),
    ).resolves.toEqual({
      message: 'If this email exists and is unverified, a new link has been sent.',
    });

    expect(calls.sentEmail).toBeUndefined();
  });

  test('keeps resend verification responses generic for verified users', async () => {
    const calls = {
      sentEmail: undefined as unknown,
    };

    const { deps } = createTestDeps({
      prisma: {
        $transaction: async (
          callback: (transaction: {
            user: {
              findUnique(): Promise<{ id: string; email: string; isVerified: boolean }>;
            };
            emailVerificationToken: { upsert(): Promise<never> };
          }) => Promise<unknown>,
        ) =>
          callback({
            user: {
              findUnique: async () => ({
                id: 'user-id',
                email: 'user@example.com',
                isVerified: true,
              }),
            },
            emailVerificationToken: {
              upsert: async () => {
                throw new Error('Should not rotate a token for verified users');
              },
            },
          }),
      } as unknown as AuthDeps['prisma'],
      mailer: {
        sendVerificationEmail: async (email: string, token: string) => {
          calls.sentEmail = { email, token };
        },
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.resendVerification({
        email: 'user@example.com',
      }),
    ).resolves.toEqual({
      message: 'If this email exists and is unverified, a new link has been sent.',
    });

    expect(calls.sentEmail).toBeUndefined();
  });

  test('keeps resend verification accepted when email delivery fails', async () => {
    const mailerError = new MailerDeliveryError('Email failed');
    const { deps, calls } = createTestDeps({
      mailer: {
        sendVerificationEmail: async () => {
          throw mailerError;
        },
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.resendVerification({
        email: 'user@example.com',
      }),
    ).resolves.toEqual({
      message: 'If this email exists and is unverified, a new link has been sent.',
    });

    expect(calls.warning).toEqual({
      data: { err: mailerError },
      message: 'Verification email could not be sent after resend request',
    });
  });
});
