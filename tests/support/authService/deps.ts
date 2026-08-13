import type { AuthDeps } from './context.js';
import { createAuthServiceTestCalls, fixedNow } from './context.js';
import { createBaseAuthPrisma } from './prisma.js';

type AuthPrismaOverride = Omit<Partial<AuthDeps['prisma']>, '$transaction'> & {
  $transaction?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
};

type AuthDepsOverrides = Omit<Partial<AuthDeps>, 'prisma'> & {
  prisma?: AuthPrismaOverride;
};

export function createTestDeps(overrides: AuthDepsOverrides = {}) {
  const calls = createAuthServiceTestCalls();
  const basePrisma = createBaseAuthPrisma(calls);
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
      bucket: 'user-media',
      putObject: async (input: unknown) => {
        calls.putObject = input;
      },
    },
    externalResources: {
      reconcileTarget: async (input: unknown) => {
        calls.reconcileTarget = input;
        return 'skipped' as const;
      },
      reconcileDue: async (input: unknown) => {
        calls.reconcileDue = input;
        return {
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        };
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
