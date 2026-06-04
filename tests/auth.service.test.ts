import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../src/services/auth.service.js';
import {
  AccountBannedError,
  EmailNotVerifiedError,
  InvalidEmailVerificationTokenError,
  InvalidCredentialsError,
  InvalidPasswordResetTokenError,
  PasswordResetPasswordReuseError,
  PasswordResetStateChangedError,
  UserAlreadyExistsError,
} from '../src/services/auth.errors.js';
import {
  CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';

type AuthDeps = Parameters<typeof createAuthService>[0];

const fixedNow = new Date('2026-01-01T00:00:00.000Z');

function createTestDeps(overrides: Partial<AuthDeps> = {}) {
  const calls = {
    userFindUnique: undefined as unknown,
    userFindFirst: undefined as unknown,
    userCreate: undefined as unknown,
    userDeleteMany: undefined as unknown,
    userUpdate: undefined as unknown,
    userUpdateMany: undefined as unknown,
    tokenCreate: undefined as unknown,
    tokenDeleteMany: undefined as unknown,
    tokenFindUnique: undefined as unknown,
    tokenUpsert: undefined as unknown,
    passwordResetTokenDeleteMany: undefined as unknown,
    passwordResetTokenFindUnique: undefined as unknown,
    passwordResetTokenUpsert: undefined as unknown,
    sessionCreate: undefined as unknown,
    sessionCount: undefined as unknown,
    sessionFindMany: undefined as unknown,
    sessionFindUnique: undefined as unknown,
    sessionUpdate: undefined as unknown,
    sessionUpdateMany: undefined as unknown,
    sessionDeleteMany: undefined as unknown,
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
      deleteMany: async (args: unknown) => {
        calls.userDeleteMany = args;

        return { count: 1 };
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
    passwordResetToken: {
      upsert: async (args: unknown) => {
        calls.passwordResetTokenUpsert = args;
      },
      deleteMany: async (args: unknown) => {
        calls.passwordResetTokenDeleteMany = args;

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
      deleteMany: async (args: unknown) => {
        calls.sessionDeleteMany = args;

        return { count: 3 };
      },
    },
  };

  const deps = {
    prisma: {
      $transaction: async (
        input: ((transaction: typeof tx) => Promise<unknown>) | Promise<unknown>[],
      ) => (Array.isArray(input) ? Promise.all(input) : input(tx)),
      user: {
        findUnique: async (args: unknown) => {
          calls.userFindUnique = args;

          return {
            id: 'user-id',
            email: 'user@example.com',
            username: 'fairplay_user',
            displayName: 'Fairplay User',
            bio: null,
            role: 'user',
            isVerified: true,
            isBanned: false,
            bannedAt: null,
            createdAt: fixedNow,
            updatedAt: fixedNow,
            lastLogin: fixedNow,
            sessions: [
              {
                id: 'session-id',
                sessionKeySuffix: 'in-token',
                ipAddress: '127.0.0.1',
                userAgent: 'bun-test',
                deviceInfo: 'bun-test',
                isActive: true,
                createdAt: fixedNow,
                updatedAt: fixedNow,
                lastUsedAt: fixedNow,
                expiresAt: new Date('2026-01-31T00:00:00.000Z'),
              },
              {
                id: 'other-session-id',
                sessionKeySuffix: null,
                ipAddress: null,
                userAgent: null,
                deviceInfo: null,
                isActive: false,
                createdAt: fixedNow,
                updatedAt: fixedNow,
                lastUsedAt: new Date('2026-01-01T00:00:01.000Z'),
                expiresAt: new Date('2026-01-31T00:00:00.000Z'),
              },
            ],
            emailVerificationTokens: [
              {
                id: 'verification-token-id',
                createdAt: fixedNow,
                expiresAt: new Date('2026-01-08T00:00:00.000Z'),
              },
            ],
            passwordResetToken: {
              id: 'password-reset-token-id',
              createdAt: fixedNow,
              expiresAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          };
        },
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
      passwordResetToken: {
        deleteMany: async (args: unknown) => {
          calls.passwordResetTokenDeleteMany = args;

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
        count: async (args: unknown) => {
          calls.sessionCount = args;

          return 2;
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
        deleteMany: async (args: unknown) => {
          calls.sessionDeleteMany = args;

          return { count: 3 };
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
      sendPasswordResetEmail: async (email: string, token: string) => {
        calls.sentEmail = { email, token };
      },
    },
    clock: {
      now: () => fixedNow,
    },
    config: {
      bcryptRounds: 12,
      emailVerificationTokenTtlMs: 1000,
      passwordResetTokenTtlMs: 60 * 60 * 1000,
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

type PasswordResetTestUser = {
  id: string;
  email: string;
  isVerified: boolean;
  isBanned: boolean;
} | null;

function createPasswordResetTestDeps(
  user: PasswordResetTestUser,
  overrides: Partial<AuthDeps> = {},
) {
  const { deps, calls } = createTestDeps(overrides);
  const passwordResetTx = {
    user: {
      findUnique: async (args: unknown) => {
        calls.userFindUnique = args;

        return user;
      },
    },
    passwordResetToken: {
      upsert: async (args: unknown) => {
        calls.passwordResetTokenUpsert = args;
      },
    },
  };

  return {
    deps: {
      ...deps,
      prisma: {
        ...deps.prisma,
        $transaction: async (callback: (transaction: typeof passwordResetTx) => Promise<unknown>) =>
          callback(passwordResetTx),
      } as unknown as AuthDeps['prisma'],
    },
    calls,
  };
}

type PasswordResetTokenRecord = {
  userId: string;
  token: string;
  expiresAt: Date;
  user: {
    id: string;
    passwordHash: string;
    isBanned: boolean;
  };
} | null;

type PasswordResetConfirmationOptions = {
  consumeCount?: number;
  currentPasswordHash?: string;
  updateUserCount?: number;
};

function createPasswordResetConfirmationTestDeps(
  record: PasswordResetTokenRecord,
  overrides: Partial<AuthDeps> = {},
  options: PasswordResetConfirmationOptions = {},
) {
  const { deps, calls } = createTestDeps(overrides);
  const consumeCount = options.consumeCount ?? 1;
  const currentPasswordHash = options.currentPasswordHash ?? record?.user.passwordHash;
  const updateUserCount = options.updateUserCount ?? 1;
  const passwordResetTx = {
    passwordResetToken: {
      deleteMany: async (args: unknown) => {
        calls.passwordResetTokenDeleteMany = args;

        return { count: consumeCount };
      },
    },
    user: {
      findUnique: async (args: unknown) => {
        calls.userFindUnique = args;

        if (!record) {
          return null;
        }

        return {
          passwordHash: currentPasswordHash,
          isBanned: record.user.isBanned,
        };
      },
      updateMany: async (args: unknown) => {
        calls.userUpdateMany = args;

        return { count: updateUserCount };
      },
    },
    session: {
      updateMany: async (args: unknown) => {
        calls.sessionUpdateMany = args;

        return { count: 2 };
      },
    },
  };

  return {
    deps: {
      ...deps,
      prisma: {
        ...deps.prisma,
        $transaction: async (callback: (transaction: typeof passwordResetTx) => Promise<unknown>) =>
          callback(passwordResetTx),
        passwordResetToken: {
          findUnique: async (args: unknown) => {
            calls.passwordResetTokenFindUnique = args;

            return record;
          },
          deleteMany: async (args: unknown) => {
            calls.passwordResetTokenDeleteMany = args;

            return { count: 1 };
          },
        },
      } as unknown as AuthDeps['prisma'],
    },
    calls,
  };
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
      nextCursor: null,
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
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
    expect(calls.sessionCount).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
        expiresAt: {
          gt: fixedNow,
        },
      },
    });
  });

  test('caps active session list page size', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await service.getUserSessions({
      userId: 'user-id',
      currentSessionId: 'session-id',
      limit: 10_000,
    });

    expect(calls.sessionFindMany).toEqual(
      expect.objectContaining({
        take: 101,
      }),
    );
  });

  test('logs out all active user sessions', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(service.logoutAllSessions({ userId: 'user-id' })).resolves.toEqual({
      message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
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
      message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
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
      message: LOGOUT_SESSION_SUCCESS_MESSAGE,
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
      message: UPDATE_PROFILE_SUCCESS_MESSAGE,
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

  test('exports user data without selecting secret fields', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.exportUserData({
        userId: 'user-id',
        currentSessionId: 'session-id',
      }),
    ).resolves.toEqual({
      exportedAt: fixedNow,
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
        isVerified: true,
        isBanned: false,
        bannedAt: null,
        createdAt: fixedNow,
        updatedAt: fixedNow,
        lastLogin: fixedNow,
      },
      sessions: [
        {
          id: 'session-id',
          sessionKeySuffix: 'in-token',
          ipAddress: '127.0.0.1',
          userAgent: 'bun-test',
          deviceInfo: 'bun-test',
          isActive: true,
          isCurrent: true,
          createdAt: fixedNow,
          updatedAt: fixedNow,
          lastUsedAt: fixedNow,
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        },
        {
          id: 'other-session-id',
          sessionKeySuffix: null,
          ipAddress: null,
          userAgent: null,
          deviceInfo: null,
          isActive: false,
          isCurrent: false,
          createdAt: fixedNow,
          updatedAt: fixedNow,
          lastUsedAt: new Date('2026-01-01T00:00:01.000Z'),
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        },
      ],
      emailVerificationToken: {
        id: 'verification-token-id',
        createdAt: fixedNow,
        expiresAt: new Date('2026-01-08T00:00:00.000Z'),
      },
      passwordResetToken: {
        id: 'password-reset-token-id',
        createdAt: fixedNow,
        expiresAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    });

    expect(calls.userFindUnique).toEqual({
      where: { id: 'user-id' },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
        isVerified: true,
        isBanned: true,
        bannedAt: true,
        createdAt: true,
        updatedAt: true,
        lastLogin: true,
        sessions: {
          select: {
            id: true,
            sessionKeySuffix: true,
            ipAddress: true,
            userAgent: true,
            deviceInfo: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
            lastUsedAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        emailVerificationTokens: {
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
        passwordResetToken: {
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
          },
        },
      },
    });
    const selectedFields = JSON.stringify(calls.userFindUnique);
    expect(selectedFields).not.toContain('"passwordHash":');
    expect(selectedFields).not.toContain('"sessionKey":');
    expect(selectedFields).not.toContain('"token":');
  });

  test('deletes user personal data for account deletion', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
    });

    expect(calls.sessionDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
    expect(calls.tokenDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
    expect(calls.userDeleteMany).toEqual({
      where: { id: 'user-id' },
    });
  });

  test('cleans up expired and old inactive sessions', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);
    const expiredBefore = new Date('2026-01-01T00:00:00.000Z');
    const inactiveUpdatedBefore = new Date('2025-12-02T00:00:00.000Z');

    await expect(
      service.cleanupSessions({
        expiredBefore,
        inactiveUpdatedBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_SESSION_SUCCESS_MESSAGE,
      sessionsDeleted: 3,
    });

    expect(calls.sessionDeleteMany).toEqual({
      where: {
        OR: [
          { expiresAt: { lt: expiredBefore } },
          {
            isActive: false,
            updatedAt: { lt: inactiveUpdatedBefore },
          },
        ],
      },
    });
  });

  test('cleans up expired auth tokens', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);
    const expiredBefore = new Date('2026-01-01T00:00:00.000Z');

    await expect(
      service.cleanupExpiredAuthTokens({
        expiredBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
      emailVerificationTokensDeleted: 1,
      passwordResetTokensDeleted: 1,
    });

    expect(calls.tokenDeleteMany).toEqual({
      where: {
        expiresAt: {
          lt: expiredBefore,
        },
      },
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        expiresAt: {
          lt: expiredBefore,
        },
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
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    });

    expect(calls.userFindUnique).toEqual({
      where: { email: 'user@example.com' },
      select: { id: true, email: true, isVerified: true, isBanned: true },
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
          sendVerificationEmail: async (email: string, token: string) => {
            calls.sentEmail = { email, token };
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
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T01:00:00.000Z'),
      },
      create: {
        userId: 'user-id',
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T01:00:00.000Z'),
      },
    });

    expect(calls.sentEmail).toEqual({
      email: 'user@example.com',
      token: 'plain-token',
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

  test('resets a password, consumes the token, and revokes active sessions', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
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
        token: 'plain-token',
        password: 'NewPassword1!',
      }),
    ).resolves.toEqual({
      message: RESET_PASSWORD_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });

    expect(calls.passwordResetTokenFindUnique).toEqual({
      where: { token: 'hashed-plain-token' },
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
    expect(calls.comparedPassword).toEqual({
      password: 'NewPassword1!',
      hash: 'hashed-old-password',
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        token: 'hashed-plain-token',
        expiresAt: {
          gt: fixedNow,
        },
      },
    });
    expect(calls.userFindUnique).toEqual({
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

  test('rejects missing password reset tokens', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(null);
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        token: 'plain-token',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toBeUndefined();
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('deletes and rejects expired password reset tokens', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps({
      userId: 'user-id',
      token: 'hashed-plain-token',
      expiresAt: fixedNow,
      user: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
        isBanned: false,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        token: 'plain-token',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: { token: 'hashed-plain-token' },
    });
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('rejects password reset when the token expires before transaction consumption', async () => {
    const consumedAt = new Date('2026-01-01T00:00:02.000Z');
    let nowCalls = 0;
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
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
        token: 'plain-token',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        token: 'hashed-plain-token',
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
      token: 'hashed-plain-token',
      expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      user: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
        isBanned: true,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        token: 'plain-token',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(AccountBannedError);

    expect(calls.passwordResetTokenDeleteMany).toBeUndefined();
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('rejects password reset when the new password matches the current password', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps({
      userId: 'user-id',
      token: 'hashed-plain-token',
      expiresAt: new Date('2026-01-01T00:00:01.000Z'),
      user: {
        id: 'user-id',
        passwordHash: 'hashed-old-password',
        isBanned: false,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.resetPassword({
        token: 'plain-token',
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
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
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
        token: 'plain-token',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(PasswordResetStateChangedError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        token: 'hashed-plain-token',
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
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
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
        token: 'plain-token',
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

  test('rejects already consumed password reset tokens inside the transaction', async () => {
    const { deps, calls } = createPasswordResetConfirmationTestDeps(
      {
        userId: 'user-id',
        token: 'hashed-plain-token',
        expiresAt: new Date('2026-01-01T00:00:01.000Z'),
        user: {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
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
        token: 'plain-token',
        password: 'NewPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidPasswordResetTokenError);

    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        token: 'hashed-plain-token',
        expiresAt: {
          gt: fixedNow,
        },
      },
    });
    expect(calls.userUpdateMany).toBeUndefined();
    expect(calls.sessionUpdateMany).toBeUndefined();
  });
});
