import type { AuthDeps, AuthServiceTestCalls } from './context.js';
import { fixedNow } from './context.js';

const createUserMediaAssetStore = (calls: AuthServiceTestCalls) => ({
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

    return calls.previousUserMediaTargetId
      ? { externalResourceTargetId: calls.previousUserMediaTargetId }
      : null;
  },
  upsert: async (args: unknown) => {
    calls.userMediaAssetUpsert = args;
    const upsertArgs = args as {
      update?: {
        objectKey?: string;
        bucket?: string;
        mimeType?: string;
        sizeBytes?: number;
        width?: number;
        height?: number;
      };
      create?: {
        objectKey?: string;
        bucket?: string;
        mimeType?: string;
        sizeBytes?: number;
        width?: number;
        height?: number;
      };
    };
    const data = upsertArgs.update ?? upsertArgs.create;

    return {
      objectKey: data?.objectKey ?? 'users/user-id/avatar/test-avatar.webp',
      bucket: data?.bucket ?? 'fairplay-user-media',
      mimeType: data?.mimeType ?? 'image/webp',
      sizeBytes: data?.sizeBytes ?? 6,
      width: data?.width ?? 512,
      height: data?.height ?? 512,
      updatedAt: fixedNow,
    };
  },
});

const createAuthTransaction = (calls: AuthServiceTestCalls) => ({
  $executeRaw: async () => 0,
  $queryRaw: async () => [],
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
        username: 'fairplay_user',
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
  userMediaAsset: createUserMediaAssetStore(calls),
  externalResourceTarget: {
    create: async (args: unknown) => {
      calls.externalResourceTargetCreate = args;
      return { id: 'target-id' };
    },
    findMany: async (args: unknown) => {
      calls.externalResourceTargetFindMany = args;
      return calls.externalResourceTargets;
    },
    findUnique: async () => ({
      state: 'confirmed_present',
      quiescenceNotBefore: null,
      nextAttemptAt: fixedNow,
    }),
    update: async (args: unknown) => {
      calls.externalResourceTargetUpdate = args;
      calls.externalResourceTargetUpdates.push(args);
      return { id: 'target-id' };
    },
    updateMany: async (args: unknown) => {
      calls.externalResourceTargetUpdateMany = args;
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
});

const createExportableUser = () => ({
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
  mediaAssets: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'avatar',
      objectKey: 'users/user-id/avatar/current-avatar.webp',
      bucket: 'fairplay-user-media',
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
      bucket: 'fairplay-user-media',
      mimeType: 'image/webp',
      sizeBytes: 2345,
      width: 1500,
      height: 500,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    },
  ],
  videoRatings: [
    {
      videoId: '33333333-3333-4333-8333-333333333333',
      value: 5,
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
});

export const createBaseAuthPrisma = (calls: AuthServiceTestCalls): AuthDeps['prisma'] => {
  const tx = createAuthTransaction(calls);
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
          ...createExportableUser(),
          isVerified: !isEmailVerificationLookup,
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
    userMediaAsset: createUserMediaAssetStore(calls),
    externalResourceTarget: {
      findUnique: async () => ({
        state: 'confirmed_present',
        quiescenceNotBefore: null,
        nextAttemptAt: fixedNow,
      }),
      update: async (args: unknown) => {
        calls.externalResourceTargetUpdate = args;
        calls.externalResourceTargetUpdates.push(args);
        return { id: 'target-id' };
      },
      updateMany: async (args: unknown) => {
        calls.externalResourceTargetUpdateMany = args;
        return { count: 1 };
      },
    },
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

  return basePrisma as unknown as AuthDeps['prisma'];
};
