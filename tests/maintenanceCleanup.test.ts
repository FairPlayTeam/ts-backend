import { describe, expect, test } from 'bun:test';
import {
  createMaintenanceCleanupJob,
  createRedisMaintenanceCleanupLock,
} from '../src/maintenance/cleanup.js';
import type { AuthMaintenancePort } from '../src/services/auth.types.js';
import type { VideoLifecycleMaintenancePort } from '../src/services/videos.types.js';
import type { VideoTranscodingMaintenancePort } from '../src/modules/videoTranscoding/index.js';
import type { VideoUploadsMaintenancePort } from '../src/modules/videoUploads/index.js';
import type {
  ExternalResourceReconciler,
  ExternalResourceReconciliationHandlers,
} from '../src/services/externalResources.js';

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

const createMaintenanceServices = (
  calls: unknown[] = [],
  {
    auth = {},
    uploads = {},
    transcoding = {},
    lifecycle = {},
  }: {
    auth?: Partial<AuthMaintenancePort>;
    uploads?: Partial<VideoUploadsMaintenancePort>;
    transcoding?: Partial<VideoTranscodingMaintenancePort>;
    lifecycle?: Partial<VideoLifecycleMaintenancePort>;
  } = {},
): {
  authService: AuthMaintenancePort;
  videoUploadsMaintenance: VideoUploadsMaintenancePort;
  videoTranscodingMaintenance: VideoTranscodingMaintenancePort;
  videoLifecycleMaintenance: VideoLifecycleMaintenancePort;
  externalResources: Pick<ExternalResourceReconciler, 'reconcileDue'>;
  videoUploadsReconciliationHandlers: Required<
    Pick<ExternalResourceReconciliationHandlers, 'source' | 'source_thumbnail'>
  >;
  videoTranscodingReconciliationHandlers: Required<
    Pick<ExternalResourceReconciliationHandlers, 'hls_artifacts' | 'thumbnail_prefix'>
  >;
} => ({
  authService: {
    cleanupSessions: async (input) => {
      calls.push(['sessions', input]);
      return {
        message: 'sessions cleaned',
        sessionsDeleted: 2,
      };
    },
    cleanupExpiredAuthTokens: async (input) => {
      calls.push(['authTokens', input]);
      return {
        message: 'tokens cleaned',
        emailVerificationTokensDeleted: 3,
        passwordResetTokensDeleted: 4,
      };
    },
    reconcileUserMediaTargets: async (input) => {
      calls.push(['userMediaTargets', input]);
      return {
        message: 'media reconciled',
        mediaTargetsConfirmed: 5,
        mediaTargetsFailed: 1,
      };
    },
    ...auth,
  },
  videoUploadsMaintenance: {
    expireMultipartUploadSessions: async (input) => {
      calls.push(['multipartSessions', input]);
      return { uploadSessionsExpired: 6 };
    },
    ...uploads,
  },
  videoTranscodingMaintenance: {
    scheduleAbandonedArtifactGenerations: async (input) => {
      calls.push(['abandonedArtifactGenerations', input]);
      return { artifactGenerationsScheduled: 7 };
    },
    ...transcoding,
  },
  videoLifecycleMaintenance: {
    deleteExpiredVideosPendingPurge: async (input) => {
      calls.push(['videosPendingPurge', input]);
      return {
        videosPendingPurgeDeleted: 12,
        videoPendingPurgeTargetsScheduled: 13,
      };
    },
    ...lifecycle,
  },
  externalResources: {
    reconcileDue: async (input) => {
      calls.push([
        'videoTargets',
        {
          roles: input.roles,
          handlerRoles: Object.keys(input.handlers ?? {}).sort(),
        },
      ]);
      return {
        claimed: 8,
        confirmed: 9,
        redirectedAbsent: 10,
        failed: 11,
      };
    },
  },
  videoUploadsReconciliationHandlers: { source: {}, source_thumbnail: {} },
  videoTranscodingReconciliationHandlers: { hls_artifacts: {}, thumbnail_prefix: {} },
});

const cleanupConfig = {
  intervalMs: 60_000,
  inactiveRetentionMs: 30 * 24 * 60 * 60 * 1000,
};

describe('maintenance cleanup job', () => {
  test('runs every cleanup step sequentially with deterministic cutoffs and an aggregate summary', async () => {
    const calls: unknown[] = [];
    const { logs, logger } = createLogger();
    const services = createMaintenanceServices(calls);
    const job = createMaintenanceCleanupJob({
      ...services,
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: cleanupConfig,
      logger,
    });

    const result = await job.runOnce();

    expect(calls).toEqual([
      [
        'sessions',
        {
          expiredBefore: new Date('2026-01-31T00:00:00.000Z'),
          inactiveUpdatedBefore: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      [
        'authTokens',
        {
          expiredBefore: new Date('2026-01-31T00:00:00.000Z'),
        },
      ],
      ['userMediaTargets', {}],
      [
        'multipartSessions',
        {
          expiredBefore: new Date('2026-01-31T00:00:00.000Z'),
        },
      ],
      [
        'abandonedArtifactGenerations',
        {
          observedAt: new Date('2026-01-31T00:00:00.000Z'),
        },
      ],
      [
        'videoTargets',
        {
          roles: ['source', 'source_thumbnail', 'hls_artifacts', 'thumbnail_prefix'],
          handlerRoles: ['hls_artifacts', 'source', 'source_thumbnail', 'thumbnail_prefix'],
        },
      ],
      [
        'videosPendingPurge',
        {
          observedAt: new Date('2026-01-31T00:00:00.000Z'),
          purgeBefore: new Date('2026-01-24T00:00:00.000Z'),
        },
      ],
    ]);
    expect(result).toEqual({
      skipped: false,
      lockLost: false,
      summary: {
        sessionsDeleted: 2,
        emailVerificationTokensDeleted: 3,
        passwordResetTokensDeleted: 4,
        mediaTargetsConfirmed: 5,
        mediaTargetsFailed: 1,
        uploadSessionsExpired: 6,
        artifactGenerationsScheduled: 7,
        videoTargetsClaimed: 8,
        videoTargetsConfirmed: 9,
        videoTargetsRedirectedAbsent: 10,
        videoTargetsFailed: 11,
        videosPendingPurgeDeleted: 12,
        videoPendingPurgeTargetsScheduled: 13,
      },
      failedSteps: [],
    });
    expect(logs).toContainEqual({
      level: 'info',
      data: result.summary,
      message: 'Maintenance cleanup completed',
    });
  });

  test('isolates failed steps and continues the remaining sequence', async () => {
    const calls: unknown[] = [];
    const sessionError = new Error('session cleanup unavailable');
    const generationError = new Error('generation scan unavailable');
    const { logs, logger } = createLogger();
    const services = createMaintenanceServices(calls, {
      auth: {
        cleanupSessions: async () => {
          calls.push(['sessions']);
          throw sessionError;
        },
      },
      transcoding: {
        scheduleAbandonedArtifactGenerations: async () => {
          calls.push(['abandonedArtifactGenerations']);
          throw generationError;
        },
      },
    });
    const job = createMaintenanceCleanupJob({
      ...services,
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: cleanupConfig,
      logger,
    });

    const result = await job.runOnce();

    expect(calls.map((call) => (Array.isArray(call) ? call[0] : call))).toEqual([
      'sessions',
      'authTokens',
      'userMediaTargets',
      'multipartSessions',
      'abandonedArtifactGenerations',
      'videoTargets',
      'videosPendingPurge',
    ]);
    expect(result.failedSteps).toEqual(['sessions', 'abandonedArtifactGenerations']);
    expect(logs).toContainEqual({
      level: 'error',
      data: { err: sessionError, cleanupStep: 'sessions' },
      message: 'Maintenance cleanup step failed',
    });
    expect(logs).toContainEqual({
      level: 'error',
      data: {
        err: generationError,
        cleanupStep: 'abandonedArtifactGenerations',
      },
      message: 'Maintenance cleanup step failed',
    });
  });

  test('isolates a pending-video purge failure after every earlier step has completed', async () => {
    const calls: unknown[] = [];
    const purgeError = new Error('pending video purge unavailable');
    const services = createMaintenanceServices(calls, {
      lifecycle: {
        deleteExpiredVideosPendingPurge: async () => {
          calls.push(['videosPendingPurge']);
          throw purgeError;
        },
      },
    });
    const job = createMaintenanceCleanupJob({
      ...services,
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: cleanupConfig,
      logger: createLogger().logger,
    });

    const result = await job.runOnce();

    expect(calls.map((call) => (Array.isArray(call) ? call[0] : call))).toEqual([
      'sessions',
      'authTokens',
      'userMediaTargets',
      'multipartSessions',
      'abandonedArtifactGenerations',
      'videoTargets',
      'videosPendingPurge',
    ]);
    expect(result.failedSteps).toEqual(['videosPendingPurge']);
    expect(result.summary).toMatchObject({
      sessionsDeleted: 2,
      videoTargetsConfirmed: 9,
    });
  });

  test('does not overlap concurrent local runs', async () => {
    const calls: unknown[] = [];
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const services = createMaintenanceServices(calls, {
      auth: {
        cleanupSessions: async () => {
          calls.push(['sessions']);
          cleanupStarted.resolve();
          await releaseCleanup.promise;

          return {
            message: 'sessions cleaned',
            sessionsDeleted: 1,
          };
        },
      },
    });
    const job = createMaintenanceCleanupJob({
      ...services,
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: cleanupConfig,
      logger: createLogger().logger,
    });

    const firstRun = job.runOnce();
    const secondRun = job.runOnce();
    await cleanupStarted.promise;

    expect(calls).toHaveLength(1);
    releaseCleanup.resolve();
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
    expect(firstResult).toBe(secondResult);
    expect(calls).toHaveLength(7);
  });

  test('acquires, renews, and releases the Redis lock only while its token is owned', async () => {
    const redisCalls: unknown[][] = [];
    const lockManager = createRedisMaintenanceCleanupLock({
      redisClient: {
        call: async (...args: unknown[]) => {
          redisCalls.push(args);

          if (args[0] === 'set') {
            return 'OK';
          }

          return 1;
        },
      },
      ttlMs: 300_000,
      tokenFactory: () => 'instance-token',
    });
    const lock = await lockManager.acquire();

    if (!lock) {
      throw new Error('Expected the maintenance lock to be acquired');
    }

    expect(lock.renewalIntervalMs).toBe(100_000);
    await expect(lock.renew()).resolves.toBe(true);
    await lock.release();
    expect(redisCalls).toEqual([
      ['set', 'maintenance:cleanup:lock', 'instance-token', 'PX', '300000', 'NX'],
      [
        'eval',
        expect.stringContaining('redis.call("pexpire", KEYS[1], ARGV[2])'),
        '1',
        'maintenance:cleanup:lock',
        'instance-token',
        '300000',
      ],
      [
        'eval',
        expect.stringContaining('redis.call("del", KEYS[1])'),
        '1',
        'maintenance:cleanup:lock',
        'instance-token',
      ],
    ]);
  });

  test('skips cleanup when another instance holds the distributed lock', async () => {
    const calls: unknown[] = [];
    const { logs, logger } = createLogger();
    const lock = createRedisMaintenanceCleanupLock({
      redisClient: {
        call: async () => null,
      },
      ttlMs: 300_000,
      tokenFactory: () => 'instance-token',
    });
    const job = createMaintenanceCleanupJob({
      ...createMaintenanceServices(calls),
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: cleanupConfig,
      lock,
      logger,
    });

    await expect(job.runOnce()).resolves.toEqual({
      skipped: true,
      lockLost: false,
      summary: {},
      failedSteps: [],
    });
    expect(calls).toEqual([]);
    expect(logs).toContainEqual({
      level: 'info',
      data: { lockKey: 'maintenance:cleanup:lock' },
      message: 'Maintenance cleanup skipped because another instance holds the lock',
    });
  });

  test('reports lock loss and stops before the next cleanup step', async () => {
    const calls: unknown[] = [];
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    let released = false;
    const services = createMaintenanceServices(calls, {
      auth: {
        cleanupSessions: async () => {
          calls.push(['sessions']);
          cleanupStarted.resolve();
          await releaseCleanup.promise;

          return {
            message: 'sessions cleaned',
            sessionsDeleted: 1,
          };
        },
      },
    });
    const job = createMaintenanceCleanupJob({
      ...services,
      clock: {
        now: () => new Date('2026-01-31T00:00:00.000Z'),
      },
      config: cleanupConfig,
      lock: {
        acquire: async () => ({
          renewalIntervalMs: 10,
          renew: async () => false,
          release: async () => {
            released = true;
          },
        }),
      },
      logger: createLogger().logger,
    });

    const run = job.runOnce();
    await cleanupStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseCleanup.resolve();
    const result = await run;

    expect(calls).toEqual([['sessions']]);
    expect(result).toEqual({
      skipped: false,
      lockLost: true,
      summary: {
        sessionsDeleted: 1,
      },
      failedSteps: ['lockOwnership'],
    });
    expect(released).toBe(true);
  });
});
