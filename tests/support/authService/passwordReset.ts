import type { AuthDeps } from './context.js';
import { createTestDeps } from './deps.js';

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
