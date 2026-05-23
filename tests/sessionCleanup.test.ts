import { describe, expect, test } from 'bun:test';
import { createSessionCleanupJob } from '../src/maintenance/sessionCleanup.js';

describe('session cleanup job', () => {
  test('runs cleanup with deterministic cutoffs', async () => {
    const calls: unknown[] = [];
    const logs: unknown[] = [];
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
      logger: {
        error: (data, message) => logs.push({ level: 'error', data, message }),
        info: (data, message) => logs.push({ level: 'info', data, message }),
      },
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
      logger: {
        error: () => undefined,
        info: () => undefined,
      },
    });

    const firstRun = job.runOnce();
    const secondRun = job.runOnce();

    expect(calls).toBe(1);
    resolveCleanup?.();
    await Promise.all([firstRun, secondRun]);
    expect(calls).toBe(1);
  });
});
