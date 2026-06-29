import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../src/services/auth.service.js';
import {
  AccountBannedError,
  EmailNotVerifiedError,
  InvalidCredentialsError,
  UserAlreadyExistsError,
} from '../src/services/auth.errors.js';
import {
  LOGIN_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';
import { createDefaultAuthPrisma, createTestDeps, fixedNow } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

describe('auth service credentials', () => {
  test('registers a user and sends a verification email', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    const result = await service.register({
      email: ' USER@Example.COM ',
      username: ' FairPlay_User ',
      password: 'Password1!',
    });

    expect(result).toEqual({
      message: REGISTER_SUCCESS_MESSAGE,
    });

    expect(calls.userCreate).toEqual({
      data: {
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'fairplay_user',
        passwordHash: 'hashed-password',
      },
      select: { id: true, email: true, username: true, role: true },
    });

    expect(calls.tokenCreate).toEqual({
      data: {
        userId: 'user-id',
        token: 'hashed-code-user-id:123456',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    });

    expect(calls.sentEmail).toEqual({
      email: 'user@example.com',
      token: '123456',
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
        sendPasswordResetEmail: async () => undefined,
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
      message: REGISTER_SUCCESS_MESSAGE,
    });

    expect(calls.warning).toEqual({
      data: { err: mailerError },
      message: 'Verification email could not be sent after registration',
    });
  });

  test('logs in a verified active user and creates a hashed session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.login({
        emailOrUsername: ' USER@Example.COM ',
        password: 'Password1!',
        ipAddress: '127.0.0.1',
        userAgent: 'bun-test',
      }),
    ).resolves.toEqual({
      message: LOGIN_SUCCESS_MESSAGE,
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

    expect(calls.userFindFirst).toEqual({
      where: {
        OR: [{ email: 'user@example.com' }, { username: 'user@example.com' }],
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
        passwordHash: true,
        isVerified: true,
        isBanned: true,
      },
    });

    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
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

    expect(calls.userUpdate).toEqual({
      where: { id: 'user-id' },
      data: { lastLogin: fixedNow },
    });
  });

  test('rejects login with generic invalid credentials for missing users', async () => {
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async () => {
          throw new Error('Should not create a session for missing users');
        },
        user: {
          findFirst: async () => null,
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.login({
        emailOrUsername: 'missing@example.com',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const comparedPassword = calls.comparedPassword as { password: string; hash: string };
    expect(comparedPassword.password).toBe('Password1!');
    expect(typeof comparedPassword.hash).toBe('string');
    expect(comparedPassword.hash.length).toBeGreaterThan(0);
  });

  test('uses configured bcrypt rounds for the missing-user login comparison hash', async () => {
    let hashCall: { password: string; rounds: number } | undefined;
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async () => {
          throw new Error('Should not create a session for missing users');
        },
        user: {
          findFirst: async () => null,
        },
      } as unknown as AuthDeps['prisma'],
      hasher: {
        hash: async (password: string, rounds: number) => {
          hashCall = { password, rounds };
          return `missing-user-hash-rounds-${rounds}`;
        },
        compare: async (password: string, hash: string) => {
          calls.comparedPassword = { password, hash };
          return false;
        },
      },
      config: {
        bcryptRounds: 14,
        emailVerificationTokenTtlMs: 1000,
        passwordResetTokenTtlMs: 60 * 60 * 1000,
        sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.login({
        emailOrUsername: 'missing@example.com',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(hashCall).toEqual({
      password: expect.any(String),
      rounds: 14,
    });
    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'missing-user-hash-rounds-14',
    });
  });

  test('rejects login with generic invalid credentials for wrong passwords', async () => {
    const { deps } = createTestDeps({
      hasher: {
        hash: async () => 'hashed-password',
        compare: async () => false,
      },
    });

    const service = createAuthService(deps);

    await expect(
      service.login({
        emailOrUsername: 'user@example.com',
        password: 'WrongPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  test('rejects login for banned users after password verification', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        user: {
          findFirst: async () => ({
            id: 'user-id',
            email: 'user@example.com',
            username: 'fairplay_user',
            role: 'user',
            passwordHash: 'hashed-password',
            isVerified: true,
            isBanned: true,
          }),
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.login({
        emailOrUsername: 'user@example.com',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(AccountBannedError);
  });

  test('rejects login for unverified users after password verification', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        user: {
          findFirst: async () => ({
            id: 'user-id',
            email: 'user@example.com',
            username: 'fairplay_user',
            role: 'user',
            passwordHash: 'hashed-password',
            isVerified: false,
            isBanned: false,
          }),
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.login({
        emailOrUsername: 'user@example.com',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(EmailNotVerifiedError);
  });
});
