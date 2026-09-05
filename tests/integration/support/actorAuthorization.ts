import type { AuthRole } from '../../../src/services/auth.roles.js';
import { waitForPostgresLockWaiters } from './postgresLocks.js';
import { createPrismaClient, type TestRuntime } from './runtime.js';

export const waitForBlockedActorAuthorizationQuery = async (
  runtime: TestRuntime,
  signal: AbortSignal,
): Promise<void> =>
  waitForPostgresLockWaiters(runtime.prisma, {
    applicationNames: [runtime.postgresApplicationName],
    expectedCount: 1,
    queryFragments: ['FROM "users"', 'FOR UPDATE'],
    signal,
    timeoutMs: 5_000,
  });

export const beginHeldActorDowngrade = (
  runtime: TestRuntime,
  actorUserId: string,
  role: Exclude<AuthRole, 'admin'>,
) => {
  const prisma = createPrismaClient(runtime.databaseUrl);
  const downgradeApplied = Promise.withResolvers<void>();
  const releaseDowngrade = Promise.withResolvers<void>();
  const transaction = prisma.$transaction(
    async (tx) => {
      await tx.user.update({
        where: { id: actorUserId },
        data: { role },
      });
      downgradeApplied.resolve();
      await releaseDowngrade.promise;
    },
    {
      timeout: 15_000,
    },
  );

  return {
    disconnect: () => prisma.$disconnect(),
    paused: downgradeApplied.promise,
    release: releaseDowngrade.resolve,
    transaction,
  };
};
