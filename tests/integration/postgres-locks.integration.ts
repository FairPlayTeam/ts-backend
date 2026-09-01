import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createVerifiedSession } from './support/fixtures.js';
import { throwCollectedErrors, waitForBarrier } from './support/asyncBarriers.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  createPrismaClient,
  createPostgresApplicationName,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

describe('PostgreSQL lock-waiter test support', () => {
  let runtime: TestRuntime | null = null;

  beforeAll(async () => {
    runtime = await startRuntime();
  });

  beforeEach(async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    await resetState(runtime);
  });

  afterAll(async () => {
    await stopRuntime(runtime);
  });

  test('matches only identified lock waiters with explicit exact or minimum counts', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'postgres-lock-filter@example.com',
      username: 'postgres_lock_filter',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'PostgreSQL lock filter',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const gateApplicationName = createPostgresApplicationName();
    const waiterApplicationNames = [
      createPostgresApplicationName(),
      createPostgresApplicationName(),
    ] as const;
    const gatePrisma = createPrismaClient(runtime.databaseUrl, {
      applicationName: gateApplicationName,
    });
    const firstWaiterPrisma = createPrismaClient(runtime.databaseUrl, {
      applicationName: waiterApplicationNames[0],
    });
    const secondWaiterPrisma = createPrismaClient(runtime.databaseUrl, {
      applicationName: waiterApplicationNames[1],
    });
    const gateAcquired = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const gateTransaction = gatePrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "videos"
          WHERE "id" = CAST(${created.video.id} AS UUID)
          FOR UPDATE
        `;
        gateAcquired.resolve();
        await releaseGate.promise;
      },
      { timeout: 15_000 },
    );
    const blockedQueries: Promise<unknown>[] = [];
    let operationSettlement: Promise<PromiseSettledResult<unknown>[]> | null = null;
    const coordinationErrors: unknown[] = [];

    try {
      await waitForBarrier({
        description: 'the literal-fragment video-row gate',
        operations: [gateTransaction],
        signal: gateAcquired.promise,
        timeoutMs: 5_000,
      });
      const observationCancellation = new AbortController();
      const cancellationError = new Error('PostgreSQL lock observation cancelled');
      const cancelledObservation = waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: waiterApplicationNames,
        expectedCount: 99,
        queryFragments: ['FROM "videos"'],
        signal: observationCancellation.signal,
      });
      observationCancellation.abort(cancellationError);
      await expect(cancelledObservation).rejects.toBe(cancellationError);

      blockedQueries.push(
        firstWaiterPrisma.$queryRaw`
            SELECT "id"
            FROM "videos"
            WHERE "id" = CAST(${created.video.id} AS UUID)
            FOR UPDATE
          `.then(() => undefined),
        secondWaiterPrisma.$queryRaw`
            SELECT "id"
            FROM "videos"
            WHERE "id" = CAST(${created.video.id} AS UUID)
            FOR UPDATE
          `.then(() => undefined),
      );
      operationSettlement = Promise.allSettled([gateTransaction, ...blockedQueries]);
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: waiterApplicationNames,
        expectedCount: 2,
        queryFragments: ['FROM "videos"'],
      });
      await expect(
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: waiterApplicationNames,
          expectedCount: 1,
          queryFragments: ['FROM "videos"'],
          timeoutMs: 250,
        }),
      ).rejects.toThrow('Timed out waiting for exactly 1 PostgreSQL lock waiter(s)');
      await expect(
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: waiterApplicationNames,
          countMode: 'at-least',
          expectedCount: 1,
          queryFragments: ['FROM "videos"'],
        }),
      ).resolves.toBeUndefined();
      await expect(
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: [gateApplicationName],
          expectedCount: 2,
          queryFragments: ['FROM "videos"'],
          timeoutMs: 250,
        }),
      ).rejects.toThrow('Timed out waiting for exactly 2 PostgreSQL lock waiter(s)');

      await expect(
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: waiterApplicationNames,
          expectedCount: 2,
          queryFragments: ['FROM "video_"'],
          timeoutMs: 250,
        }),
      ).rejects.toThrow('matching FROM "video_"');
      await expect(
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: waiterApplicationNames,
          expectedCount: 2,
          queryFragments: ['FROM%"videos"'],
          timeoutMs: 250,
        }),
      ).rejects.toThrow('matching FROM%"videos"');
    } catch (error) {
      coordinationErrors.push(error);
    } finally {
      releaseGate.resolve();
      const operationResults = await (operationSettlement ??
        Promise.allSettled([gateTransaction, ...blockedQueries]));

      for (const result of operationResults) {
        if (result.status === 'rejected') {
          coordinationErrors.push(result.reason);
        }
      }

      const disconnectResults = await Promise.allSettled([
        gatePrisma.$disconnect(),
        firstWaiterPrisma.$disconnect(),
        secondWaiterPrisma.$disconnect(),
      ]);

      for (const result of disconnectResults) {
        if (result.status === 'rejected') {
          coordinationErrors.push(result.reason);
        }
      }
    }

    throwCollectedErrors(coordinationErrors, 'PostgreSQL lock-waiter support test failed');
  });
});
