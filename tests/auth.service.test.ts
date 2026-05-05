import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../src/services/authService.js';
import { UserAlreadyExistsError } from '../src/services/auth.errors.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';

type AuthDeps = Parameters<typeof createAuthService>[0];

const fixedNow = new Date('2026-01-01T00:00:00.000Z');

function createTestDeps(overrides: Partial<AuthDeps> = {}) {
  const calls = {
    userCreate: undefined as unknown,
    tokenCreate: undefined as unknown,
    sentEmail: undefined as unknown,
    warning: undefined as unknown,
  };

  const tx = {
    user: {
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
    },
  };

  const deps = {
    prisma: {
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    },
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
      warn: (message: string, error?: unknown) => {
        calls.warning = { message, error };
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
      message: 'Verification email could not be sent after registration',
      error: mailerError,
    });
  });
});
