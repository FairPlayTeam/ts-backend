import type { createAuthService } from '../../src/services/auth.service.js';

export type AuthDeps = Parameters<typeof createAuthService>[0];

export const fixedNow = new Date('2026-01-01T00:00:00.000Z');
export const avatarObjectKeyPattern =
  /^users\/user-id\/avatar\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
export const bannerObjectKeyPattern =
  /^users\/user-id\/banner\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

type UserMediaDeletionJobCalls = {
  userMediaDeletionJobCreateMany: unknown;
  userMediaDeletionJobDeleteMany: unknown;
  userMediaDeletionJobFindMany: unknown;
  userMediaDeletionJobUpdateMany: unknown;
};

export const createUserMediaDeletionJobMock = (calls: UserMediaDeletionJobCalls) => ({
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

export const createUserMediaAssetDeletionTransaction = ({
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

export function createTestDeps(overrides: Partial<AuthDeps> = {}) {
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
    passwordResetUserFindUnique: undefined as unknown,
    passwordResetCurrentUserFindUnique: undefined as unknown,
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
          token: 'hashed-code-user-id:123456',
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
      hashAuthCode: (secret: string) => `hashed-code-${secret}`,
      hashOpaqueToken: (token: string) => `hashed-${token}`,
    },
    mailer: {
      sendVerificationEmail: async (email: string, code: string) => {
        calls.sentEmail = { email, token: code };
      },
      sendPasswordResetEmail: async (email: string, code: string) => {
        calls.sentEmail = { email, token: code };
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
      passwordResetTokenTtlMs: 15 * 60 * 1000,
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

export const createDefaultAuthPrisma = (): AuthDeps['prisma'] => createTestDeps().deps.prisma;

export type PasswordResetTestUser = {
  id: string;
  email: string;
  isVerified: boolean;
  isBanned: boolean;
} | null;

export function createPasswordResetTestDeps(
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
    isVerified: boolean;
    isBanned: boolean;
  };
} | null;

type PasswordResetConfirmationOptions = {
  consumeCount?: number;
  currentPasswordHash?: string;
  updateUserCount?: number;
  user?: {
    id: string;
    passwordHash: string;
    isVerified: boolean;
    isBanned: boolean;
  } | null;
};

export function createPasswordResetConfirmationTestDeps(
  record: PasswordResetTokenRecord,
  overrides: Partial<AuthDeps> = {},
  options: PasswordResetConfirmationOptions = {},
) {
  const { deps, calls } = createTestDeps(overrides);
  const initialUser =
    options.user === undefined
      ? (record?.user ?? {
          id: 'user-id',
          passwordHash: 'hashed-old-password',
          isVerified: true,
          isBanned: false,
        })
      : options.user;
  const consumeCount = options.consumeCount ?? 1;
  const currentPasswordHash = options.currentPasswordHash ?? initialUser?.passwordHash;
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
        calls.passwordResetCurrentUserFindUnique = args;

        if (!initialUser) {
          return null;
        }

        return {
          passwordHash: currentPasswordHash,
          isBanned: initialUser.isBanned,
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
        user: {
          findUnique: async (args: unknown) => {
            calls.passwordResetUserFindUnique = args;

            return initialUser;
          },
        },
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
