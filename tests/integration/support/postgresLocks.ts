import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, type PrismaClient } from '@prisma/client';

export const waitForPostgresLockWaiters = async (
  prisma: PrismaClient,
  {
    applicationNames,
    countMode = 'exact',
    expectedCount,
    queryFragments,
    signal,
    timeoutMs = 5_000,
  }: {
    applicationNames: readonly [string, ...string[]];
    countMode?: 'at-least' | 'exact';
    expectedCount: number;
    queryFragments: readonly [string, ...string[]];
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const queryFilters = Prisma.join(
    queryFragments.map((fragment) => Prisma.sql`strpos(query, ${fragment}) > 0`),
    ' AND ',
  );
  const applicationNameList = Prisma.join(applicationNames);

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const [activity] = await prisma.$queryRaw<Array<{ blockedCount: number }>>(Prisma.sql`
      SELECT count(*)::int AS "blockedCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND application_name IN (${applicationNameList})
        AND ${queryFilters}
    `);
    signal?.throwIfAborted();

    const blockedCount = activity?.blockedCount ?? 0;
    const countMatches =
      countMode === 'exact' ? blockedCount === expectedCount : blockedCount >= expectedCount;

    if (countMatches) {
      return;
    }

    await delay(25, undefined, { signal });
  }

  throw new Error(
    `Timed out waiting for ${countMode === 'exact' ? 'exactly ' : 'at least '}${expectedCount} PostgreSQL lock waiter(s) from ${applicationNames.join(', ')} matching ${queryFragments.join(' and ')}`,
  );
};
