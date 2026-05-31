import { describe, expect, test } from 'bun:test';
import {
  createRedisSessionCleanupLock,
  createSessionCleanupJob,
} from '../src/maintenance/sessionCleanup.js';

const createLogger = () => {
  const logs: unknown[] = [];

  return {
    logs,
    logger: {
      error: (data: object, message: string) => logs.push({ level: 'error', data, message }),
      info: (data: object, message: string) => logs.push({ level: 'info', data, message }),
      warn: (data: object, message: string) => logs.push({ level: 'warn', data, message }),
    },
  };
};

describe('session cleanup job', () => {
  test('runs cleanup with deterministic cutoffs', async () => {
    const calls: unknown[] = [];
    const { logs, logger } = createLogger();
    const job = createSessionCleanupJob({
      authService: {
        cleanupSessions: async (input) => {
          calls.push(input);

          return {
            message: 'Sessions cleaned up successfully',
            sessionsDeleted: 2,
          };
        },
      },
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 30 * 24 * 60 * 60 * 1000,
      },
      logger,
    });

    await job.runOnce();

    expect(calls).toEqual([
      {
        expiredBefore: new Date('2026-01-31T00:00:00.000Z'),
        inactiveUpdatedBefore: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    expect(logs).toContainEqual({
      level: 'info',
      data: { sessionsDeleted: 2 },
      message: 'Session cleanup completed',
    });
  });

  test('does not overlap concurrent cleanup runs', async () => {
    let calls = 0;
    let resolveCleanup: (() => void) | undefined;
    const job = createSessionCleanupJob({
      authService: {
        cleanupSessions: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            resolveCleanup = resolve;
          });

          return {
            message: 'Sessions cleaned up successfully',
            sessionsDeleted: 1,
          };
        },
      },
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 1_000,
      },
      logger: createLogger().logger,
    });

    const firstRun = job.runOnce();
    const secondRun = job.runOnce();

    expect(calls).toBe(1);
    resolveCleanup?.();
    await Promise.all([firstRun, secondRun]);
    expect(calls).toBe(1);
  });

  test('runs cleanup only after acquiring the distributed lock', async () => {
    const cleanupCalls: unknown[] = [];
    const redisCalls: unknown[][] = [];
    const lock = createRedisSessionCleanupLock({
      redisClient: {
        call: async (...args: unknown[]) => {
          redisCalls.push(args);
          return args[0] === 'set' ? 'OK' : 1;
        },
      },
      ttlMs: 300_000,
      tokenFactory: () => 'instance-token',
    });
    const job = createSessionCleanupJob({
      authService: {
        cleanupSessions: async (input) => {
          cleanupCalls.push(input);

          return {
            message: 'Sessions cleaned up successfully',
            sessionsDeleted: 1,
          };
        },
      },
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 1_000,
      },
      lock,
      logger: createLogger().logger,
    });

    await job.runOnce();

    expect(cleanupCalls).toHaveLength(1);
    expect(redisCalls).toEqual([
      ['set', 'maintenance:session-cleanup:lock', 'instance-token', 'PX', '300000', 'NX'],
      [
        'eval',
        expect.stringContaining('redis.call("get", KEYS[1])'),
        '1',
        'maintenance:session-cleanup:lock',
        'instance-token',
      ],
    ]);
  });

  test('skips cleanup when another instance holds the distributed lock', async () => {
    let cleanupCalls = 0;
    const { logs, logger } = createLogger();
    const lock = createRedisSessionCleanupLock({
      redisClient: {
        call: async () => null,
      },
      ttlMs: 300_000,
      tokenFactory: () => 'instance-token',
    });
    const job = createSessionCleanupJob({
      authService: {
        cleanupSessions: async () => {
          cleanupCalls += 1;

          return {
            message: 'Sessions cleaned up successfully',
            sessionsDeleted: 1,
          };
        },
      },
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 1_000,
      },
      lock,
      logger,
    });

    await job.runOnce();

    expect(cleanupCalls).toBe(0);
    expect(logs).toContainEqual({
      level: 'info',
      data: { lockKey: 'maintenance:session-cleanup:lock' },
      message: 'Session cleanup skipped because another instance holds the lock',
    });
  });
});
