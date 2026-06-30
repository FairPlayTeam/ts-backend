import { describe, expect, test } from 'bun:test';
import {
  createRedisAuthCleanupLock,
  createAuthCleanupJob,
} from '../src/maintenance/authCleanup.js';
import {
  CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
  CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';

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

describe('auth cleanup job', () => {
  test('runs cleanup with deterministic cutoffs', async () => {
    const calls: unknown[] = [];
    const { logs, logger } = createLogger();
    const job = createAuthCleanupJob({
      authService: {
        cleanupSessions: async (input) => {
          calls.push(input);

          return {
            message: CLEANUP_SESSION_SUCCESS_MESSAGE,
            sessionsDeleted: 2,
          };
        },
        cleanupExpiredAuthTokens: async (input) => {
          calls.push(input);

          return {
            message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
            emailVerificationTokensDeleted: 3,
            passwordResetTokensDeleted: 4,
          };
        },
        cleanupPendingUserMediaDeletions: async (input) => {
          calls.push(input);

          return {
            message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
            mediaObjectsDeleted: 5,
            mediaObjectDeletionJobsFailed: 0,
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
      {
        expiredBefore: new Date('2026-01-31T00:00:00.000Z'),
      },
      {
        pendingBefore: new Date('2026-01-31T00:00:00.000Z'),
      },
    ]);
    expect(logs).toContainEqual({
      level: 'info',
      data: {
        sessionsDeleted: 2,
        emailVerificationTokensDeleted: 3,
        passwordResetTokensDeleted: 4,
        mediaObjectsDeleted: 5,
        mediaObjectDeletionJobsFailed: 0,
      },
      message: 'Auth cleanup completed',
    });
  });

  test('continues remaining cleanup steps when one step fails', async () => {
    const calls: string[] = [];
    const cleanupError = new Error('session cleanup unavailable');
    const { logs, logger } = createLogger();
    const job = createAuthCleanupJob({
      authService: {
        cleanupSessions: async () => {
          calls.push('sessions');
          throw cleanupError;
        },
        cleanupExpiredAuthTokens: async () => {
          calls.push('authTokens');

          return {
            message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
            emailVerificationTokensDeleted: 3,
            passwordResetTokensDeleted: 4,
          };
        },
        cleanupPendingUserMediaDeletions: async () => {
          calls.push('userMediaDeletionJobs');

          return {
            message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
            mediaObjectsDeleted: 5,
            mediaObjectDeletionJobsFailed: 1,
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

    expect(calls).toEqual(['sessions', 'authTokens', 'userMediaDeletionJobs']);
    expect(logs).toContainEqual({
      level: 'error',
      data: { err: cleanupError, cleanupStep: 'sessions' },
      message: 'Auth cleanup step failed',
    });
    expect(logs).toContainEqual({
      level: 'warn',
      data: {
        emailVerificationTokensDeleted: 3,
        passwordResetTokensDeleted: 4,
        mediaObjectsDeleted: 5,
        mediaObjectDeletionJobsFailed: 1,
        failedCleanupSteps: ['sessions'],
      },
      message: 'Auth cleanup completed with failures',
    });
  });

  test('does not overlap concurrent cleanup runs', async () => {
    let calls = 0;
    let resolveCleanup: (() => void) | undefined;
    const job = createAuthCleanupJob({
      authService: {
        cleanupSessions: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            resolveCleanup = resolve;
          });

          return {
            message: CLEANUP_SESSION_SUCCESS_MESSAGE,
            sessionsDeleted: 1,
          };
        },
        cleanupExpiredAuthTokens: async () => {
          calls += 1;

          return {
            message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
            emailVerificationTokensDeleted: 1,
            passwordResetTokensDeleted: 1,
          };
        },
        cleanupPendingUserMediaDeletions: async () => {
          calls += 1;

          return {
            message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
            mediaObjectsDeleted: 1,
            mediaObjectDeletionJobsFailed: 0,
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
    expect(calls).toBe(3);
  });

  test('runs cleanup only after acquiring the distributed lock', async () => {
    const cleanupCalls: unknown[] = [];
    const redisCalls: unknown[][] = [];
    const lock = createRedisAuthCleanupLock({
      redisClient: {
        call: async (...args: unknown[]) => {
          redisCalls.push(args);
          return args[0] === 'set' ? 'OK' : 1;
        },
      },
      ttlMs: 300_000,
      tokenFactory: () => 'instance-token',
    });
    const job = createAuthCleanupJob({
      authService: {
        cleanupSessions: async (input) => {
          cleanupCalls.push(input);

          return {
            message: CLEANUP_SESSION_SUCCESS_MESSAGE,
            sessionsDeleted: 1,
          };
        },
        cleanupExpiredAuthTokens: async (input) => {
          cleanupCalls.push(input);

          return {
            message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
            emailVerificationTokensDeleted: 1,
            passwordResetTokensDeleted: 1,
          };
        },
        cleanupPendingUserMediaDeletions: async (input) => {
          cleanupCalls.push(input);

          return {
            message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
            mediaObjectsDeleted: 1,
            mediaObjectDeletionJobsFailed: 0,
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

    expect(cleanupCalls).toHaveLength(3);
    expect(redisCalls).toEqual([
      ['set', 'maintenance:auth-cleanup:lock', 'instance-token', 'PX', '300000', 'NX'],
      [
        'eval',
        expect.stringContaining('redis.call("get", KEYS[1])'),
        '1',
        'maintenance:auth-cleanup:lock',
        'instance-token',
      ],
    ]);
  });

  test('skips cleanup when another instance holds the distributed lock', async () => {
    let cleanupCalls = 0;
    const { logs, logger } = createLogger();
    const lock = createRedisAuthCleanupLock({
      redisClient: {
        call: async () => null,
      },
      ttlMs: 300_000,
      tokenFactory: () => 'instance-token',
    });
    const job = createAuthCleanupJob({
      authService: {
        cleanupSessions: async () => {
          cleanupCalls += 1;

          return {
            message: CLEANUP_SESSION_SUCCESS_MESSAGE,
            sessionsDeleted: 1,
          };
        },
        cleanupExpiredAuthTokens: async () => {
          cleanupCalls += 1;

          return {
            message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
            emailVerificationTokensDeleted: 1,
            passwordResetTokensDeleted: 1,
          };
        },
        cleanupPendingUserMediaDeletions: async () => {
          cleanupCalls += 1;

          return {
            message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
            mediaObjectsDeleted: 1,
            mediaObjectDeletionJobsFailed: 0,
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
      data: { lockKey: 'maintenance:auth-cleanup:lock' },
      message: 'Auth cleanup skipped because another instance holds the lock',
    });
  });
});
