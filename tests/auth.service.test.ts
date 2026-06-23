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
  ProfileUpdateEmptyError,
  UserAlreadyExistsError,
} from '../src/services/auth.errors.js';
import {
  CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
  CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';

type AuthDeps = Parameters<typeof createAuthService>[0];

const fixedNow = new Date('2026-01-01T00:00:00.000Z');
const avatarObjectKeyPattern =
  /^users\/user-id\/avatar\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
const bannerObjectKeyPattern =
  /^users\/user-id\/banner\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

type UserMediaDeletionJobCalls = {
  userMediaDeletionJobCreateMany: unknown;
  userMediaDeletionJobDeleteMany: unknown;
  userMediaDeletionJobFindMany: unknown;
  userMediaDeletionJobUpdateMany: unknown;
};

const createUserMediaDeletionJobMock = (calls: UserMediaDeletionJobCalls) => ({
  createMany: async (args: unknown) => {
    calls.userMediaDeletionJobCreateMany = args;

    const data = (args as { data?: unknown[] }).data;

    return { count: data?.length ?? 1 };
  },
  deleteMany: async (args: unknown) => {
    calls.userMediaDeletionJobDeleteMany = args;

    return { count: 1 };
  },
  findMany: async (args: unknown) => {
    calls.userMediaDeletionJobFindMany = args;

    return [];
  },
  updateMany: async (args: unknown) => {
    calls.userMediaDeletionJobUpdateMany = args;
  },
});

type UserMediaAssetDeletionCalls = UserMediaDeletionJobCalls & {
  userMediaAssetDeleteMany: unknown;
  userMediaAssetFindUnique: unknown;
};

const createUserMediaAssetDeletionTransaction = ({
  calls,
  deleteMany,
  objectKey,
}: {
  calls: UserMediaAssetDeletionCalls;
  deleteMany?: (args: unknown) => Promise<{ count: number }>;
  objectKey: string;
}) => ({
  userMediaAsset: {
    findUnique: async (args: unknown) => {
      calls.userMediaAssetFindUnique = args;

      return { objectKey };
    },
    deleteMany: async (args: unknown) => {
      calls.userMediaAssetDeleteMany = args;

      return deleteMany ? deleteMany(args) : { count: 1 };
    },
  },
  userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
});

function createTestDeps(overrides: Partial<AuthDeps> = {}) {
  const calls = {
    userFindUnique: undefined as unknown,
    userFindFirst: undefined as unknown,
    userCreate: undefined as unknown,
    userDeleteMany: undefined as unknown,
    userUpdate: undefined as unknown,
    userUpdateMany: undefined as unknown,
    userMediaAssetDeleteMany: undefined as unknown,
    userMediaAssetFindMany: undefined as unknown,
    userMediaAssetFindUnique: undefined as unknown,
    userMediaAssetUpsert: undefined as unknown,
    userMediaDeletionJobCreateMany: undefined as unknown,
    userMediaDeletionJobDeleteMany: undefined as unknown,
    userMediaDeletionJobFindMany: undefined as unknown,
    userMediaDeletionJobUpdateMany: undefined as unknown,
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
    putObject: undefined as unknown,
    deleteObject: undefined as unknown,
    deleteObjects: undefined as unknown,
    signedUrlObjectKey: undefined as unknown,
    signedUrlObjectKeys: [] as string[],
    processedMedia: undefined as unknown,
    comparedPassword: undefined as unknown,
    sentEmail: undefined as unknown,
    warning: undefined as unknown,
  };

  const tx = {
    user: {
      findUnique: async (args: unknown) => {
        calls.userFindUnique = args;
        const select = (args as { select?: Record<string, unknown> }).select;

        if (select?.passwordHash) {
          return {
            passwordHash: 'hashed-password',
            isBanned: false,
          };
        }

        return {
          id: 'user-id',
          email: 'user@example.com',
          isVerified: false,
          isBanned: false,
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
      updateMany: async (args: unknown) => {
        calls.userUpdateMany = args;

        return { count: 1 };
      },
      deleteMany: async (args: unknown) => {
        calls.userDeleteMany = args;

        return { count: 1 };
      },
    },
    userMediaAsset: {
      findMany: async (args: unknown) => {
        calls.userMediaAssetFindMany = args;

        return [];
      },
      findUnique: async (args: unknown) => {
        calls.userMediaAssetFindUnique = args;

        return null;
      },
      deleteMany: async (args: unknown) => {
        calls.userMediaAssetDeleteMany = args;

        return { count: 1 };
      },
      upsert: async (args: unknown) => {
        calls.userMediaAssetUpsert = args;
        const upsertArgs = args as {
          update?: {
            objectKey?: string;
            mimeType?: string;
            sizeBytes?: number;
            width?: number;
            height?: number;
          };
          create?: {
            objectKey?: string;
            mimeType?: string;
            sizeBytes?: number;
            width?: number;
            height?: number;
          };
        };
        const data = upsertArgs.update ?? upsertArgs.create;

        return {
          objectKey: data?.objectKey ?? 'users/user-id/avatar/test-avatar.webp',
          mimeType: data?.mimeType ?? 'image/webp',
          sizeBytes: data?.sizeBytes ?? 6,
          width: data?.width ?? 512,
          height: data?.height ?? 512,
          updatedAt: fixedNow,
        };
      },
    },
    userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
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

  const basePrisma = {
    $transaction: async (
      input: ((transaction: typeof tx) => Promise<unknown>) | Promise<unknown>[],
    ) => (Array.isArray(input) ? Promise.all(input) : input(tx)),
    user: {
      findUnique: async (args: unknown) => {
        calls.userFindUnique = args;
        const { select, where } = args as {
          select?: Record<string, unknown>;
          where?: Record<string, unknown>;
        };
        const isEmailVerificationLookup = Boolean(
          typeof where?.email === 'string' && select?.username && select?.isVerified,
        );

        if (select?.passwordHash) {
          return {
            passwordHash: 'hashed-password',
            isBanned: false,
          };
        }

        return {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          displayName: 'Fairplay User',
          bio: null,
          role: 'user',
          isVerified: !isEmailVerificationLookup,
          isBanned: false,
          bannedAt: null,
          createdAt: fixedNow,
          updatedAt: fixedNow,
          lastLogin: fixedNow,
          mediaAssets: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              kind: 'avatar',
              objectKey: 'users/user-id/avatar/current-avatar.webp',
              mimeType: 'image/webp',
              sizeBytes: 1234,
              width: 512,
              height: 512,
              createdAt: fixedNow,
              updatedAt: fixedNow,
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              kind: 'banner',
              objectKey: 'users/user-id/banner/current-banner.webp',
              mimeType: 'image/webp',
              sizeBytes: 2345,
              width: 1500,
              height: 500,
              createdAt: fixedNow,
              updatedAt: fixedNow,
            },
          ],
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
    userMediaAsset: {
      deleteMany: async (args: unknown) => {
        calls.userMediaAssetDeleteMany = args;

        return { count: 1 };
      },
      findMany: async (args: unknown) => {
        calls.userMediaAssetFindMany = args;

        return [];
      },
      findUnique: async (args: unknown) => {
        calls.userMediaAssetFindUnique = args;

        return null;
      },
      upsert: async (args: unknown) => {
        calls.userMediaAssetUpsert = args;
        const upsertArgs = args as {
          update?: {
            objectKey?: string;
            mimeType?: string;
            sizeBytes?: number;
            width?: number;
            height?: number;
          };
          create?: {
            objectKey?: string;
            mimeType?: string;
            sizeBytes?: number;
            width?: number;
            height?: number;
          };
        };
        const data = upsertArgs.update ?? upsertArgs.create;

        return {
          objectKey: data?.objectKey ?? 'users/user-id/avatar/test-avatar.webp',
          mimeType: data?.mimeType ?? 'image/webp',
          sizeBytes: data?.sizeBytes ?? 6,
          width: data?.width ?? 512,
          height: data?.height ?? 512,
          updatedAt: fixedNow,
        };
      },
    },
    userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
    emailVerificationToken: {
      findUnique: async (args: unknown) => {
        calls.tokenFindUnique = args;

        return {
          id: 'verification-token-id',
          userId: 'user-id',
          token: 'hashed-user-id:123456',
          expiresAt: new Date('2026-01-01T00:00:01.000Z'),
          createdAt: fixedNow,
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
  };

  const { prisma: prismaOverride, ...dependencyOverrides } = overrides;

  const deps = {
    prisma: {
      ...basePrisma,
      ...(prismaOverride ?? {}),
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
      generateSixDigitCode: () => '123456',
      hash: (token: string) => `hashed-${token}`,
    },
    mailer: {
      sendVerificationEmail: async (email: string, code: string) => {
        calls.sentEmail = { email, token: code };
      },
      sendPasswordResetEmail: async (email: string, token: string) => {
        calls.sentEmail = { email, token };
      },
    },
    objectStorage: {
      putObject: async (input: unknown) => {
        calls.putObject = input;
      },
      deleteObject: async (objectKey: string) => {
        calls.deleteObject = objectKey;
      },
      getSignedUrl: async (objectKey: string) => {
        calls.signedUrlObjectKey = objectKey;
        calls.signedUrlObjectKeys.push(objectKey);

        return `http://localhost:9000/fairplay-user-media/${objectKey}`;
      },
    },
    userMediaProcessor: {
      process: async (input: unknown) => {
        calls.processedMedia = input;
        const kind = (input as { kind?: string }).kind;

        return kind === 'banner'
          ? {
              buffer: Buffer.from('banner'),
              mimeType: 'image/webp',
              sizeBytes: 7,
              width: 1500,
              height: 500,
            }
          : {
              buffer: Buffer.from('avatar'),
              mimeType: 'image/webp',
              sizeBytes: 6,
              width: 512,
              height: 512,
            };
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
    ...dependencyOverrides,
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
        token: 'hashed-user-id:123456',
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
        ...createTestDeps().deps.prisma,
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
        ...createTestDeps().deps.prisma,
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
        ...createTestDeps().deps.prisma,
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
        ...createTestDeps().deps.prisma,
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
        ...createTestDeps().deps.prisma,
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
        ...createTestDeps().deps.prisma,
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
        ...createTestDeps().deps.prisma,
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

    await expect(
      service.logoutAllSessions({ userId: 'user-id', currentPassword: 'Password1!' }),
    ).resolves.toEqual({
      message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });

    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
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

  test('returns profile data with signed profile media urls', async () => {
    const { deps, calls } = createTestDeps();
    const avatarObjectKey = 'users/user-id/avatar/current-avatar.webp';
    const bannerObjectKey = 'users/user-id/banner/current-banner.webp';
    const service = createAuthService({
      ...deps,
      prisma: {
        ...deps.prisma,
        user: {
          ...deps.prisma.user,
          findUnique: async (args: unknown) => {
            calls.userFindUnique = args;

            return {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              displayName: 'Fairplay User',
              bio: 'Definitely not an undercover Y**tube employee.',
              role: 'user',
              mediaAssets: [
                {
                  kind: 'avatar',
                  objectKey: avatarObjectKey,
                },
                {
                  kind: 'banner',
                  objectKey: bannerObjectKey,
                },
              ],
            };
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    await expect(
      service.getProfile({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: 'Definitely not an undercover Y**tube employee.',
        role: 'user',
        avatarUrl: `http://localhost:9000/fairplay-user-media/${avatarObjectKey}`,
        bannerUrl: `http://localhost:9000/fairplay-user-media/${bannerObjectKey}`,
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
        mediaAssets: {
          where: {
            kind: {
              in: ['avatar', 'banner'],
            },
          },
          select: {
            kind: true,
            objectKey: true,
          },
        },
      },
    });
    expect(calls.signedUrlObjectKeys).toEqual([avatarObjectKey, bannerObjectKey]);
  });

  test('returns profile data with null media urls when no profile media exists', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService({
      ...deps,
      prisma: {
        ...deps.prisma,
        user: {
          ...deps.prisma.user,
          findUnique: async (args: unknown) => {
            calls.userFindUnique = args;

            return {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              displayName: 'Fairplay User',
              bio: null,
              role: 'user',
              mediaAssets: [],
            };
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    await expect(
      service.getProfile({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
        avatarUrl: null,
        bannerUrl: null,
      },
    });

    expect(calls.signedUrlObjectKeys).toEqual([]);
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

  test('rejects empty profile updates at the service boundary', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.updateProfile({
        userId: 'user-id',
      }),
    ).rejects.toBeInstanceOf(ProfileUpdateEmptyError);

    expect(calls.userUpdate).toBeUndefined();
  });

  test('uploads and stores a normalized avatar for a user', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    const result = await service.uploadAvatar({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });
    const objectKey = calls.signedUrlObjectKey as string;

    expect(objectKey).toMatch(avatarObjectKeyPattern);
    expect(result).toEqual({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: {
        url: `http://localhost:9000/fairplay-user-media/${objectKey}`,
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
        updatedAt: fixedNow,
      },
    });

    expect(calls.processedMedia).toEqual({
      kind: 'avatar',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });
    expect(calls.putObject).toEqual({
      objectKey,
      body: Buffer.from('avatar'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=900',
    });
    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      select: {
        objectKey: true,
      },
    });
    expect(calls.userMediaAssetUpsert).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      update: {
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
      },
      create: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
      },
      select: {
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
        updatedAt: true,
      },
    });
  });

  test('deletes the previous avatar object after replacing it', async () => {
    const previousObjectKey = 'users/user-id/avatar/previous-avatar.webp';
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            userMediaAsset: {
              findUnique: async (args: unknown) => {
                calls.userMediaAssetFindUnique = args;

                return {
                  objectKey: previousObjectKey,
                };
              },
              upsert: async (args: unknown) => {
                calls.userMediaAssetUpsert = args;
                const upsertArgs = args as {
                  update: {
                    objectKey: string;
                    mimeType: string;
                    sizeBytes: number;
                    width: number;
                    height: number;
                  };
                };

                return {
                  ...upsertArgs.update,
                  updatedAt: fixedNow,
                };
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          }),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    const result = await service.uploadAvatar({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });

    expect(result.message).toBe(UPLOAD_AVATAR_SUCCESS_MESSAGE);
    expect(calls.signedUrlObjectKey).toMatch(avatarObjectKeyPattern);
    expect(calls.deleteObject).toBe(previousObjectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey: previousObjectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toEqual({
      where: { objectKey: previousObjectKey },
    });
  });

  test('keeps avatar upload successful when previous object cleanup fails', async () => {
    const previousObjectKey = 'users/user-id/avatar/previous-avatar.webp';
    const cleanupError = new Error('object storage unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            userMediaAsset: {
              findUnique: async () => ({
                objectKey: previousObjectKey,
              }),
              upsert: async (args: unknown) => {
                const upsertArgs = args as {
                  update: {
                    objectKey: string;
                    mimeType: string;
                    sizeBytes: number;
                    width: number;
                    height: number;
                  };
                };

                return {
                  ...upsertArgs.update,
                  updatedAt: fixedNow,
                };
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          }),
      } as unknown as AuthDeps['prisma'],
      objectStorage: {
        putObject: async (input: unknown) => {
          calls.putObject = input;
        },
        deleteObject: async (objectKey: string) => {
          calls.deleteObject = objectKey;
          throw cleanupError;
        },
        getSignedUrl: async (objectKey: string) => {
          calls.signedUrlObjectKey = objectKey;

          return `http://localhost:9000/fairplay-user-media/${objectKey}`;
        },
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: {
          buffer: Buffer.from('raw-avatar'),
          size: 10,
        },
      }),
    ).resolves.toMatchObject({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
    });

    expect(calls.deleteObject).toBe(previousObjectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey: previousObjectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toBeUndefined();
    expect(calls.warning).toEqual({
      data: { err: cleanupError, userId: 'user-id', objectKey: previousObjectKey },
      message:
        'Previous user media object cleanup failed after replacement; cleanup remains queued',
    });
  });

  test('retries avatar persistence on serializable transaction conflicts', async () => {
    const conflictError = new Prisma.PrismaClientKnownRequestError('Transaction conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    const previousObjectKey = 'users/user-id/avatar/previous-after-conflict.webp';
    const transactionOptions: unknown[] = [];
    let transactionAttempts = 0;
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (
          callback: (transaction: unknown) => Promise<unknown>,
          options?: unknown,
        ) => {
          transactionAttempts += 1;
          transactionOptions.push(options);

          if (transactionAttempts === 1) {
            throw conflictError;
          }

          return callback({
            userMediaAsset: {
              findUnique: async (args: unknown) => {
                calls.userMediaAssetFindUnique = args;

                return {
                  objectKey: previousObjectKey,
                };
              },
              upsert: async (args: unknown) => {
                calls.userMediaAssetUpsert = args;
                const upsertArgs = args as {
                  update: {
                    objectKey: string;
                    mimeType: string;
                    sizeBytes: number;
                    width: number;
                    height: number;
                  };
                };

                return {
                  ...upsertArgs.update,
                  updatedAt: fixedNow,
                };
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          });
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    const result = await service.uploadAvatar({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });

    expect(result.message).toBe(UPLOAD_AVATAR_SUCCESS_MESSAGE);
    expect(transactionAttempts).toBe(2);
    expect(transactionOptions).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ]);
    expect(calls.deleteObject).toBe(previousObjectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey: previousObjectKey }],
      skipDuplicates: true,
    });
    expect(calls.signedUrlObjectKey).toMatch(avatarObjectKeyPattern);
  });

  test('cleans up the uploaded avatar object when persistence fails', async () => {
    const persistenceError = new Error('database unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async () => {
          throw persistenceError;
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: {
          buffer: Buffer.from('raw-avatar'),
          size: 10,
        },
      }),
    ).rejects.toBe(persistenceError);

    const uploadedObjectKey = (calls.putObject as { objectKey: string }).objectKey;
    expect(uploadedObjectKey).toMatch(avatarObjectKeyPattern);
    expect(calls.deleteObject).toBe(uploadedObjectKey);
  });

  test('uploads and stores a normalized banner for a user', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    const result = await service.uploadBanner({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-banner'),
        size: 10,
      },
    });
    const objectKey = calls.signedUrlObjectKey as string;

    expect(objectKey).toMatch(bannerObjectKeyPattern);
    expect(result).toEqual({
      message: UPLOAD_BANNER_SUCCESS_MESSAGE,
      banner: {
        url: `http://localhost:9000/fairplay-user-media/${objectKey}`,
        mimeType: 'image/webp',
        sizeBytes: 7,
        width: 1500,
        height: 500,
        updatedAt: fixedNow,
      },
    });

    expect(calls.processedMedia).toEqual({
      kind: 'banner',
      file: {
        buffer: Buffer.from('raw-banner'),
        size: 10,
      },
    });
    expect(calls.putObject).toEqual({
      objectKey,
      body: Buffer.from('banner'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=900',
    });
    expect(calls.userMediaAssetUpsert).toMatchObject({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'banner',
        },
      },
      update: {
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: 7,
        width: 1500,
        height: 500,
      },
      create: {
        userId: 'user-id',
        kind: 'banner',
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: 7,
        width: 1500,
        height: 500,
      },
    });
  });

  test('deletes an existing avatar for a user', async () => {
    const objectKey = 'users/user-id/avatar/current-avatar.webp';
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(createUserMediaAssetDeletionTransaction({ calls, objectKey })),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });

    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      select: {
        objectKey: true,
      },
    });
    expect(calls.deleteObject).toBe(objectKey);
    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
      },
    });
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toEqual({
      where: { objectKey },
    });
  });

  test('keeps avatar deletion successful when object cleanup fails', async () => {
    const objectKey = 'users/user-id/avatar/current-avatar.webp';
    const cleanupError = new Error('object storage unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(createUserMediaAssetDeletionTransaction({ calls, objectKey })),
      } as unknown as AuthDeps['prisma'],
      objectStorage: {
        putObject: async (input: unknown) => {
          calls.putObject = input;
        },
        deleteObject: async (deletedObjectKey: string) => {
          calls.deleteObject = deletedObjectKey;
          throw cleanupError;
        },
        getSignedUrl: async (signedObjectKey: string) =>
          `http://localhost:9000/fairplay-user-media/${signedObjectKey}`,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });

    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
      },
    });
    expect(calls.deleteObject).toBe(objectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toBeUndefined();
    expect(calls.warning).toEqual({
      data: { err: cleanupError, userId: 'user-id', objectKey },
      message: 'User media object cleanup failed after record deletion; cleanup remains queued',
    });
  });

  test('does not delete avatar objects when record deletion fails', async () => {
    const objectKey = 'users/user-id/avatar/current-avatar.webp';
    const deletionError = new Error('database unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(
            createUserMediaAssetDeletionTransaction({
              calls,
              objectKey,
              deleteMany: async () => {
                throw deletionError;
              },
            }),
          ),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).rejects.toBe(deletionError);

    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
      },
    });
    expect(calls.deleteObject).toBeUndefined();
    expect(calls.userMediaDeletionJobCreateMany).toBeUndefined();
  });

  test('keeps avatar deletion idempotent when no avatar exists', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });

    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      select: {
        objectKey: true,
      },
    });
    expect(calls.deleteObject).toBeUndefined();
    expect(calls.userMediaAssetDeleteMany).toBeUndefined();
  });

  test('deletes an existing banner for a user', async () => {
    const objectKey = 'users/user-id/banner/current-banner.webp';
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(createUserMediaAssetDeletionTransaction({ calls, objectKey })),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteBanner({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_BANNER_SUCCESS_MESSAGE,
      banner: null,
    });

    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'banner',
        },
      },
      select: {
        objectKey: true,
      },
    });
    expect(calls.deleteObject).toBe(objectKey);
    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'banner',
        objectKey,
      },
    });
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toEqual({
      where: { objectKey },
    });
  });

  test('exports user data without selecting secret fields', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.exportUserData({
        userId: 'user-id',
        currentSessionId: 'session-id',
        currentPassword: 'Password1!',
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
      mediaAssets: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'avatar',
          objectKey: 'users/user-id/avatar/current-avatar.webp',
          mimeType: 'image/webp',
          sizeBytes: 1234,
          width: 512,
          height: 512,
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'banner',
          objectKey: 'users/user-id/banner/current-banner.webp',
          mimeType: 'image/webp',
          sizeBytes: 2345,
          width: 1500,
          height: 500,
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
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
        mediaAssets: {
          select: {
            id: true,
            kind: true,
            objectKey: true,
            mimeType: true,
            sizeBytes: true,
            width: true,
            height: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ kind: 'asc' }, { id: 'asc' }],
        },
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
    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
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
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
      mediaCleanupQueued: 0,
    });
    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
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

  test('deletes stored media objects after deleting an account', async () => {
    const events: string[] = [];
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
          events.push('transaction');

          return callback({
            userMediaAsset: {
              findMany: async (args: unknown) => {
                calls.userMediaAssetFindMany = args;

                return [
                  { objectKey: 'users/user-id/avatar/current-avatar.webp' },
                  { objectKey: 'users/user-id/banner/current-banner.webp' },
                ];
              },
            },
            session: {
              deleteMany: async (args: unknown) => {
                calls.sessionDeleteMany = args;
              },
            },
            emailVerificationToken: {
              deleteMany: async (args: unknown) => {
                calls.tokenDeleteMany = args;
              },
            },
            passwordResetToken: {
              deleteMany: async (args: unknown) => {
                calls.passwordResetTokenDeleteMany = args;
              },
            },
            user: {
              deleteMany: async (args: unknown) => {
                calls.userDeleteMany = args;
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          });
        },
      } as unknown as AuthDeps['prisma'],
      objectStorage: {
        putObject: async () => undefined,
        deleteObject: async (objectKey: string) => {
          events.push('deleteObject');
          calls.deleteObjects = [
            ...((calls.deleteObjects as string[] | undefined) ?? []),
            objectKey,
          ];
        },
        getSignedUrl: async (objectKey: string) =>
          `http://localhost:9000/fairplay-user-media/${objectKey}`,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
      mediaCleanupQueued: 0,
    });

    expect(calls.userMediaAssetFindMany).toEqual({
      where: { userId: 'user-id' },
      select: {
        objectKey: true,
      },
    });
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [
        { objectKey: 'users/user-id/avatar/current-avatar.webp' },
        { objectKey: 'users/user-id/banner/current-banner.webp' },
      ],
      skipDuplicates: true,
    });
    expect(calls.deleteObjects).toEqual([
      'users/user-id/avatar/current-avatar.webp',
      'users/user-id/banner/current-banner.webp',
    ]);
    expect(events).toEqual(['transaction', 'deleteObject', 'deleteObject']);
    expect(calls.userDeleteMany).toEqual({
      where: { id: 'user-id' },
    });
  });

  test('keeps account deletion successful when media object cleanup fails', async () => {
    const cleanupError = new Error('object storage unavailable');
    const objectKeys = [
      'users/user-id/avatar/current-avatar.webp',
      'users/user-id/banner/current-banner.webp',
    ];
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            userMediaAsset: {
              findMany: async () => objectKeys.map((objectKey) => ({ objectKey })),
            },
            session: {
              deleteMany: async (args: unknown) => {
                calls.sessionDeleteMany = args;
              },
            },
            emailVerificationToken: {
              deleteMany: async (args: unknown) => {
                calls.tokenDeleteMany = args;
              },
            },
            passwordResetToken: {
              deleteMany: async (args: unknown) => {
                calls.passwordResetTokenDeleteMany = args;
              },
            },
            user: {
              deleteMany: async (args: unknown) => {
                calls.userDeleteMany = args;
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          }),
      } as unknown as AuthDeps['prisma'],
      objectStorage: {
        putObject: async (input: unknown) => {
          calls.putObject = input;
        },
        deleteObject: async (objectKey: string) => {
          calls.deleteObjects = [
            ...((calls.deleteObjects as string[] | undefined) ?? []),
            objectKey,
          ];
          throw cleanupError;
        },
        getSignedUrl: async (objectKey: string) =>
          `http://localhost:9000/fairplay-user-media/${objectKey}`,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
      mediaCleanupQueued: objectKeys.length,
    });

    expect(calls.deleteObjects).toEqual(objectKeys);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: objectKeys.map((objectKey) => ({ objectKey })),
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toBeUndefined();
    expect(calls.userDeleteMany).toEqual({
      where: { id: 'user-id' },
    });
    expect(calls.warning).toEqual({
      data: { err: cleanupError, userId: 'user-id', objectKey: objectKeys[1] },
      message:
        'Stored user media object cleanup failed after account deletion; cleanup remains queued',
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

  test('cleans up queued user media object deletions', async () => {
    const deletedObjectKeys: string[] = [];
    const pendingBefore = new Date('2026-01-01T00:00:00.000Z');
    const jobs = [
      {
        id: 'media-deletion-job-1',
        objectKey: 'users/user-id/avatar/old-avatar.webp',
        attempts: 0,
      },
      {
        id: 'media-deletion-job-2',
        objectKey: 'users/user-id/banner/old-banner.webp',
        attempts: 1,
      },
    ];
    const deletedJobIds: string[] = [];
    const { deps, calls } = createTestDeps();
    const mutablePrisma = deps.prisma as unknown as {
      userMediaDeletionJob: AuthDeps['prisma']['userMediaDeletionJob'];
    };
    mutablePrisma.userMediaDeletionJob = {
      ...createUserMediaDeletionJobMock(calls),
      findMany: async (args: unknown) => {
        calls.userMediaDeletionJobFindMany = args;

        return jobs;
      },
      deleteMany: async (args: unknown) => {
        const id = (args as { where?: { id?: string } }).where?.id;

        if (id) {
          deletedJobIds.push(id);
        }

        return { count: 1 };
      },
    } as unknown as AuthDeps['prisma']['userMediaDeletionJob'];
    deps.objectStorage.deleteObject = async (objectKey: string) => {
      deletedObjectKeys.push(objectKey);
    };
    const service = createAuthService(deps);

    await expect(
      service.cleanupPendingUserMediaDeletions({
        pendingBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
      mediaObjectsDeleted: 2,
      mediaObjectDeletionJobsFailed: 0,
    });

    expect(calls.userMediaDeletionJobFindMany).toEqual({
      where: {
        nextAttemptAt: {
          lte: pendingBefore,
        },
      },
      select: {
        id: true,
        objectKey: true,
        attempts: true,
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    expect(deletedObjectKeys).toEqual(jobs.map((job) => job.objectKey));
    expect(deletedJobIds).toEqual(jobs.map((job) => job.id));
  });

  test('reschedules queued user media object deletions when object storage fails', async () => {
    const cleanupError = new Error('object storage unavailable');
    const pendingBefore = new Date('2025-12-31T23:00:00.000Z');
    const job = {
      id: 'media-deletion-job-id',
      objectKey: 'users/user-id/avatar/old-avatar.webp',
      attempts: 2,
    };
    const { deps, calls } = createTestDeps();
    const mutablePrisma = deps.prisma as unknown as {
      userMediaDeletionJob: AuthDeps['prisma']['userMediaDeletionJob'];
    };
    mutablePrisma.userMediaDeletionJob = {
      ...createUserMediaDeletionJobMock(calls),
      findMany: async () => [job],
    } as unknown as AuthDeps['prisma']['userMediaDeletionJob'];
    deps.objectStorage.deleteObject = async () => {
      throw cleanupError;
    };
    const service = createAuthService(deps);

    await expect(
      service.cleanupPendingUserMediaDeletions({
        pendingBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
      mediaObjectsDeleted: 0,
      mediaObjectDeletionJobsFailed: 1,
    });

    expect(calls.userMediaDeletionJobUpdateMany).toEqual({
      where: {
        id: job.id,
      },
      data: {
        attempts: 3,
        lastError: cleanupError.message,
        nextAttemptAt: new Date('2026-01-01T00:04:00.000Z'),
      },
    });
    expect(calls.warning).toEqual({
      data: { err: cleanupError, objectKey: job.objectKey, attempts: 3 },
      message: 'Queued user media object deletion failed',
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
