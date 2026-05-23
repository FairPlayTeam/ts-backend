import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../src/services/auth.service.js';
import {
  AccountBannedError,
  EmailNotVerifiedError,
  InvalidEmailVerificationTokenError,
  InvalidCredentialsError,
  UserAlreadyExistsError,
} from '../src/services/auth.errors.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';

type AuthDeps = Parameters<typeof createAuthService>[0];

const fixedNow = new Date('2026-01-01T00:00:00.000Z');

function createTestDeps(overrides: Partial<AuthDeps> = {}) {
  const calls = {
    userFindUnique: undefined as unknown,
    userFindFirst: undefined as unknown,
    userCreate: undefined as unknown,
    userUpdate: undefined as unknown,
    tokenCreate: undefined as unknown,
    tokenDeleteMany: undefined as unknown,
    tokenFindUnique: undefined as unknown,
    tokenUpsert: undefined as unknown,
    sessionCreate: undefined as unknown,
    sessionFindMany: undefined as unknown,
    sessionFindUnique: undefined as unknown,
    sessionUpdate: undefined as unknown,
    sessionUpdateMany: undefined as unknown,
    comparedPassword: undefined as unknown,
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
      update: async (args: unknown) => {
        calls.userUpdate = args;
      },
    },
    emailVerificationToken: {
      create: async (args: unknown) => {
        calls.tokenCreate = args;
      },
      upsert: async (args: unknown) => {
        calls.tokenUpsert = args;
      },
      deleteMany: async (args: unknown) => {
        calls.tokenDeleteMany = args;

        return { count: 1 };
      },
    },
    session: {
      create: async (args: unknown) => {
        calls.sessionCreate = args;

        return {
          id: 'session-id',
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        };
      },
    },
  };

  const deps = {
    prisma: {
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
      user: {
        findFirst: async (args: unknown) => {
          calls.userFindFirst = args;

          return {
            id: 'user-id',
            email: 'user@example.com',
            username: 'fairplay_user',
            displayName: 'Fairplay User',
            bio: null,
            role: 'user',
            passwordHash: 'hashed-password',
            isVerified: true,
            isBanned: false,
          };
        },
        update: async (args: unknown) => {
          calls.userUpdate = args;
          const updateArgs = args as {
            data?: {
              displayName?: string | null;
              bio?: string | null;
            };
          };

          return {
            id: 'user-id',
            email: 'user@example.com',
            username: 'fairplay_user',
            displayName: updateArgs.data?.displayName ?? 'Fairplay User',
            bio:
              updateArgs.data?.bio === undefined
                ? 'Definitely not an undercover Y**tube employee.'
                : updateArgs.data.bio,
            role: 'user',
          };
        },
      },
      emailVerificationToken: {
        findUnique: async (args: unknown) => {
          calls.tokenFindUnique = args;

          return {
            id: 'verification-token-id',
            userId: 'user-id',
            token: 'hashed-plain-token',
            expiresAt: new Date('2026-01-01T00:00:01.000Z'),
            createdAt: fixedNow,
            user: {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              displayName: 'Fairplay User',
              bio: null,
              role: 'user',
              isBanned: false,
            },
          };
        },
        deleteMany: async (args: unknown) => {
          calls.tokenDeleteMany = args;

          return { count: 1 };
        },
      },
      session: {
        findMany: async (args: unknown) => {
          calls.sessionFindMany = args;

          return [
            {
              id: 'session-id',
              sessionKeySuffix: 'in-token',
              ipAddress: '127.0.0.1',
              userAgent: 'bun-test',
              deviceInfo: 'bun-test',
              createdAt: fixedNow,
              lastUsedAt: fixedNow,
              expiresAt: new Date('2026-01-31T00:00:00.000Z'),
            },
            {
              id: 'other-session-id',
              sessionKeySuffix: null,
              ipAddress: null,
              userAgent: null,
              deviceInfo: null,
              createdAt: fixedNow,
              lastUsedAt: new Date('2026-01-01T00:00:01.000Z'),
              expiresAt: new Date('2026-01-31T00:00:00.000Z'),
            },
          ];
        },
        findUnique: async (args: unknown) => {
          calls.sessionFindUnique = args;

          return {
            id: 'session-id',
            expiresAt: new Date('2026-01-31T00:00:00.000Z'),
            isActive: true,
            user: {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              displayName: 'Fairplay User',
              bio: null,
              role: 'user',
              isBanned: false,
            },
          };
        },
        update: async (args: unknown) => {
          calls.sessionUpdate = args;

          return { id: 'session-id' };
        },
        updateMany: async (args: unknown) => {
          calls.sessionUpdateMany = args;

          const updateArgs = args as { where?: { id?: unknown } };

          return { count: typeof updateArgs.where?.id === 'string' ? 1 : 2 };
        },
      },
    },
    isUniqueError: () => false,
    hasher: {
      hash: async () => 'hashed-password',
      compare: async (password: string, hash: string) => {
        calls.comparedPassword = { password, hash };
        return true;
      },
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
      sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
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
        displayName: 'fairplay_user',
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
      message: 'Login successful',
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
        ...createTestDeps().deps.prisma,
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
        ...createTestDeps().deps.prisma,
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

  test('verifies an email token and creates a hashed session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        token: 'plain-token',
        ipAddress: '127.0.0.1',
        userAgent: 'bun-test',
      }),
    ).resolves.toEqual({
      message: 'Email successfully verified',
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

    expect(calls.tokenFindUnique).toEqual({
      where: { token: 'hashed-plain-token' },
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

    expect(calls.userUpdate).toEqual({
      where: { id: 'user-id' },
      data: { isVerified: true, lastLogin: fixedNow },
    });

    expect(calls.tokenDeleteMany).toEqual({
      where: { token: 'hashed-plain-token' },
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

  test('rejects missing email verification tokens', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createTestDeps().deps.prisma,
        emailVerificationToken: {
          findUnique: async () => null,
          deleteMany: async () => {
            throw new Error('Should not delete a missing verification token');
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        token: 'plain-token',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);
  });

  test('deletes and rejects expired email verification tokens', async () => {
    const { deps, calls } = createTestDeps({
      prisma: {
        ...createTestDeps().deps.prisma,
        emailVerificationToken: {
          findUnique: async () => ({
            id: 'verification-token-id',
            userId: 'user-id',
            token: 'hashed-plain-token',
            expiresAt: fixedNow,
            createdAt: fixedNow,
            user: {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              role: 'user',
              isBanned: false,
            },
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
        token: 'plain-token',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);

    expect(calls.tokenDeleteMany).toEqual({
      where: { token: 'hashed-plain-token' },
    });
  });

  test('rejects already consumed email verification tokens cleanly', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createTestDeps().deps.prisma,
        $transaction: async (
          callback: (transaction: {
            emailVerificationToken: { deleteMany(): Promise<{ count: number }> };
            user: { update(): Promise<never> };
            session: { create(): Promise<never> };
          }) => Promise<unknown>,
        ) =>
          callback({
            emailVerificationToken: {
              deleteMany: async () => ({ count: 0 }),
            },
            user: {
              update: async () => {
                throw new Error('Should not update a user for an already consumed token');
              },
            },
            session: {
              create: async () => {
                throw new Error('Should not create a session for an already consumed token');
              },
            },
          }),
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        token: 'plain-token',
      }),
    ).rejects.toBeInstanceOf(InvalidEmailVerificationTokenError);
  });

  test('rejects email verification for banned users', async () => {
    const { deps } = createTestDeps({
      prisma: {
        ...createTestDeps().deps.prisma,
        emailVerificationToken: {
          findUnique: async () => ({
            id: 'verification-token-id',
            userId: 'user-id',
            token: 'hashed-plain-token',
            expiresAt: new Date('2026-01-01T00:00:01.000Z'),
            createdAt: fixedNow,
            user: {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              role: 'user',
              isBanned: true,
            },
          }),
          deleteMany: async () => {
            throw new Error('Should not delete a banned user verification token');
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    const service = createAuthService(deps);

    await expect(
      service.verifyEmail({
        token: 'plain-token',
      }),
    ).rejects.toBeInstanceOf(AccountBannedError);
  });

  test('validates an active session and touches its last used timestamp', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(service.validateSession('plain-token')).resolves.toEqual({
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
      },
      session: {
        id: 'session-id',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
      },
    });

    expect(calls.sessionFindUnique).toEqual({
      where: { sessionKey: 'hashed-plain-token' },
      select: {
        id: true,
        expiresAt: true,
        isActive: true,
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

    expect(calls.sessionUpdateMany).toEqual({
      where: {
        id: 'session-id',
        lastUsedAt: {
          lt: new Date('2025-12-31T23:55:00.000Z'),
        },
      },
      data: { lastUsedAt: fixedNow },
    });
  });

  test('rejects missing sessions without touching last used timestamp', async () => {
    const { deps, calls } = createTestDeps({
      prisma: {
        ...createTestDeps().deps.prisma,
        session: {
          findUnique: async () => null,
          update: async () => {
            throw new Error('Should not update a missing session');
          },
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(service.validateSession('missing-token')).resolves.toBeNull();
    expect(calls.sessionUpdate).toBeUndefined();
  });

  test('rejects inactive, expired, and banned-user sessions', async () => {
    const invalidSessions = [
      {
        id: 'inactive-session',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        isActive: false,
        user: {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          role: 'user',
          isBanned: false,
        },
      },
      {
        id: 'expired-session',
        expiresAt: fixedNow,
        isActive: true,
        user: {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          role: 'user',
          isBanned: false,
        },
      },
      {
        id: 'banned-user-session',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        isActive: true,
        user: {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          role: 'user',
          isBanned: true,
        },
      },
    ];

    for (const invalidSession of invalidSessions) {
      const { deps, calls } = createTestDeps({
        prisma: {
          ...createTestDeps().deps.prisma,
          session: {
            findUnique: async () => invalidSession,
            update: async () => {
              throw new Error('Should not update an invalid session');
            },
          },
        } as unknown as AuthDeps['prisma'],
      });
      const service = createAuthService(deps);

      await expect(service.validateSession('plain-token')).resolves.toBeNull();
      expect(calls.sessionUpdate).toBeUndefined();
    }
  });

  test('lists active user sessions and marks the current session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.getUserSessions({
        userId: 'user-id',
        currentSessionId: 'session-id',
      }),
    ).resolves.toEqual({
      sessions: [
        {
          id: 'session-id',
          sessionKeySuffix: 'in-token',
          ipAddress: '127.0.0.1',
          userAgent: 'bun-test',
          deviceInfo: 'bun-test',
          createdAt: fixedNow,
          lastUsedAt: fixedNow,
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
          isCurrent: true,
        },
        {
          id: 'other-session-id',
          sessionKeySuffix: null,
          ipAddress: null,
          userAgent: null,
          deviceInfo: null,
          createdAt: fixedNow,
          lastUsedAt: new Date('2026-01-01T00:00:01.000Z'),
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
          isCurrent: false,
        },
      ],
      total: 2,
    });

    expect(calls.sessionFindMany).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
        expiresAt: {
          gt: fixedNow,
        },
      },
      select: {
        id: true,
        sessionKeySuffix: true,
        ipAddress: true,
        userAgent: true,
        deviceInfo: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
      orderBy: {
        lastUsedAt: 'desc',
      },
    });
  });

  test('logs out all active user sessions', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(service.logoutAllSessions({ userId: 'user-id' })).resolves.toEqual({
      message: 'All sessions logged out successfully',
      sessionsLoggedOut: 2,
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

  test('logs out other active user sessions while keeping the current session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.logoutOtherSessions({
        userId: 'user-id',
        currentSessionId: 'session-id',
      }),
    ).resolves.toEqual({
      message: 'Other sessions logged out successfully',
      sessionsLoggedOut: 2,
    });

    expect(calls.sessionUpdateMany).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
        id: {
          not: 'session-id',
        },
      },
      data: {
        isActive: false,
      },
    });
  });

  test('logs out one active user session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.logoutSession({
        userId: 'user-id',
        sessionId: 'target-session-id',
      }),
    ).resolves.toEqual({
      message: 'Session logged out successfully',
      sessionsLoggedOut: 1,
    });

    expect(calls.sessionUpdateMany).toEqual({
      where: {
        id: 'target-session-id',
        userId: 'user-id',
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
  });

  test('updates profile fields for a user', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.updateProfile({
        userId: 'user-id',
        displayName: 'Fairplay Creator',
        bio: null,
      }),
    ).resolves.toEqual({
      message: 'Profile updated successfully',
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay Creator',
        bio: null,
        role: 'user',
      },
    });

    expect(calls.userUpdate).toEqual({
      where: { id: 'user-id' },
      data: {
        displayName: 'Fairplay Creator',
        bio: null,
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
      },
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
