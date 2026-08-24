import type { RedisClient } from '../lib/redis.js';
import {
  createRedisLeaseManager,
  type RedisLease as MaintenanceCleanupLock,
} from '../lib/redisLease.js';
import type { AuthMaintenancePort } from '../services/auth.types.js';
import type { VideoMaintenancePort } from '../services/videos.types.js';
import { VIDEO_PENDING_PURGE_RETENTION_MS } from '../config/constants.js';

const MAINTENANCE_CLEANUP_LOCK_KEY = 'maintenance:cleanup:lock';
type MaintenanceCleanupLockManager = {
  acquire(): Promise<MaintenanceCleanupLock | null>;
};

type MaintenanceCleanupJobDependencies = {
  authService: AuthMaintenancePort;
  videosService: VideoMaintenancePort;
  clock: {
    now(): Date;
  };
  config: {
    intervalMs: number;
    inactiveRetentionMs: number;
  };
  lock?: MaintenanceCleanupLockManager | null;
  logger: {
    error(data: object, message: string): void;
    info(data: object, message: string): void;
    warn(data: object, message: string): void;
  };
};

type MaintenanceCleanupSummary = Partial<{
  sessionsDeleted: number;
  emailVerificationTokensDeleted: number;
  passwordResetTokensDeleted: number;
  mediaTargetsConfirmed: number;
  mediaTargetsFailed: number;
  uploadSessionsExpired: number;
  artifactGenerationsScheduled: number;
  videoTargetsClaimed: number;
  videoTargetsConfirmed: number;
  videoTargetsRedirectedAbsent: number;
  videoTargetsFailed: number;
  videosPendingPurgeDeleted: number;
  videoPendingPurgeTargetsScheduled: number;
}>;

type MaintenanceCleanupStep =
  | 'sessions'
  | 'authTokens'
  | 'userMediaTargets'
  | 'multipartSessions'
  | 'abandonedArtifactGenerations'
  | 'videoTargets'
  | 'videosPendingPurge'
  | 'lockOwnership';

type MaintenanceCleanupResult = {
  skipped: boolean;
  lockLost: boolean;
  summary: MaintenanceCleanupSummary;
  failedSteps: MaintenanceCleanupStep[];
};

type MaintenanceCleanupJob = {
  runOnce(): Promise<MaintenanceCleanupResult>;
  start(): void;
  stop(): Promise<void>;
};

export const createRedisMaintenanceCleanupLock = ({
  redisClient,
  ttlMs,
  tokenFactory = () => crypto.randomUUID(),
}: {
  redisClient: Pick<RedisClient, 'call'>;
  ttlMs: number;
  tokenFactory?: () => string;
}): MaintenanceCleanupLockManager => {
  const leaseManager = createRedisLeaseManager({ redisClient, ttlMs, tokenFactory });

  return {
    acquire: () => leaseManager.acquire(MAINTENANCE_CLEANUP_LOCK_KEY),
  };
};

export const createMaintenanceCleanupJob = ({
  authService,
  videosService,
  clock,
  config,
  lock,
  logger,
}: MaintenanceCleanupJobDependencies): MaintenanceCleanupJob => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentRun: Promise<MaintenanceCleanupResult> | null = null;

  const runOnce = async (): Promise<MaintenanceCleanupResult> => {
    if (currentRun) {
      return currentRun;
    }

    currentRun = (async () => {
      const now = clock.now();
      const inactiveUpdatedBefore = new Date(now.getTime() - config.inactiveRetentionMs);
      const purgeBefore = new Date(now.getTime() - VIDEO_PENDING_PURGE_RETENTION_MS);
      const summary: MaintenanceCleanupSummary = {};
      const failedSteps: MaintenanceCleanupStep[] = [];
      const pendingRenewals = new Set<Promise<void>>();
      let acquiredLock: MaintenanceCleanupLock | null = null;
      let renewalTimer: ReturnType<typeof setInterval> | null = null;
      let renewing = false;
      let lockLost = false;

      const markLockLost = (error?: unknown): void => {
        if (lockLost) {
          return;
        }

        lockLost = true;
        failedSteps.push('lockOwnership');
        logger.error(
          {
            ...(error === undefined ? {} : { err: error }),
            lockKey: MAINTENANCE_CLEANUP_LOCK_KEY,
          },
          'Maintenance cleanup lock ownership lost',
        );
      };

      const renewLock = (): void => {
        if (!acquiredLock || renewing || lockLost) {
          return;
        }

        const lockHandle = acquiredLock;
        renewing = true;
        const renewal = lockHandle
          .renew()
          .then((owned) => {
            if (!owned) {
              markLockLost();
            }
          })
          .catch((error: unknown) => {
            markLockLost(error);
          })
          .finally(() => {
            renewing = false;
            pendingRenewals.delete(renewal);
          });
        pendingRenewals.add(renewal);
      };

      try {
        acquiredLock = lock ? await lock.acquire() : null;

        if (lock && !acquiredLock) {
          logger.info(
            { lockKey: MAINTENANCE_CLEANUP_LOCK_KEY },
            'Maintenance cleanup skipped because another instance holds the lock',
          );

          return {
            skipped: true,
            lockLost: false,
            summary,
            failedSteps,
          };
        }

        if (acquiredLock) {
          renewalTimer = setInterval(renewLock, acquiredLock.renewalIntervalMs);
          renewalTimer.unref?.();
        }

        const steps: Array<{
          name: Exclude<MaintenanceCleanupStep, 'lockOwnership'>;
          run(): Promise<MaintenanceCleanupSummary>;
        }> = [
          {
            name: 'sessions',
            run: async () => {
              const result = await authService.cleanupSessions({
                expiredBefore: now,
                inactiveUpdatedBefore,
              });

              return { sessionsDeleted: result.sessionsDeleted };
            },
          },
          {
            name: 'authTokens',
            run: async () => {
              const result = await authService.cleanupExpiredAuthTokens({
                expiredBefore: now,
              });

              return {
                emailVerificationTokensDeleted: result.emailVerificationTokensDeleted,
                passwordResetTokensDeleted: result.passwordResetTokensDeleted,
              };
            },
          },
          {
            name: 'userMediaTargets',
            run: async () => {
              const result = await authService.reconcileUserMediaTargets({});

              return {
                mediaTargetsConfirmed: result.mediaTargetsConfirmed,
                mediaTargetsFailed: result.mediaTargetsFailed,
              };
            },
          },
          {
            name: 'multipartSessions',
            run: () =>
              videosService.expireMultipartUploadSessions({
                expiredBefore: now,
              }),
          },
          {
            name: 'abandonedArtifactGenerations',
            run: () =>
              videosService.scheduleAbandonedArtifactGenerations({
                observedAt: now,
              }),
          },
          {
            name: 'videoTargets',
            run: async () => {
              const result = await videosService.reconcilePendingExternalResources();

              return {
                videoTargetsClaimed: result.claimed,
                videoTargetsConfirmed: result.confirmed,
                videoTargetsRedirectedAbsent: result.redirectedAbsent,
                videoTargetsFailed: result.failed,
              };
            },
          },
          {
            name: 'videosPendingPurge',
            run: () =>
              videosService.deleteExpiredVideosPendingPurge({
                observedAt: now,
                purgeBefore,
              }),
          },
        ];

        for (const step of steps) {
          if (lockLost) {
            break;
          }

          try {
            Object.assign(summary, await step.run());
          } catch (error) {
            failedSteps.push(step.name);
            logger.error({ err: error, cleanupStep: step.name }, 'Maintenance cleanup step failed');
          }
        }

        if (renewalTimer) {
          clearInterval(renewalTimer);
          renewalTimer = null;
        }
        await Promise.allSettled(pendingRenewals);

        const result: MaintenanceCleanupResult = {
          skipped: false,
          lockLost,
          summary,
          failedSteps,
        };

        if (failedSteps.length > 0) {
          logger.warn(
            {
              ...summary,
              failedCleanupSteps: failedSteps,
              lockLost,
            },
            'Maintenance cleanup completed with failures',
          );
        } else {
          logger.info(summary, 'Maintenance cleanup completed');
        }

        return result;
      } catch (error) {
        if (!failedSteps.includes('lockOwnership')) {
          failedSteps.push('lockOwnership');
        }
        logger.error({ err: error }, 'Maintenance cleanup failed');

        return {
          skipped: false,
          lockLost,
          summary,
          failedSteps,
        };
      } finally {
        if (renewalTimer) {
          clearInterval(renewalTimer);
        }
        await Promise.allSettled(pendingRenewals);

        if (acquiredLock) {
          await acquiredLock.release().catch((error: unknown) => {
            logger.warn({ err: error }, 'Maintenance cleanup lock release failed');
          });
        }

        currentRun = null;
      }
    })();

    return currentRun;
  };

  return {
    runOnce,
    start() {
      if (timer) {
        return;
      }

      void runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, config.intervalMs);
      timer.unref?.();
      logger.info(
        {
          intervalMs: config.intervalMs,
          inactiveRetentionMs: config.inactiveRetentionMs,
        },
        'Maintenance cleanup scheduled',
      );
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      await currentRun;
    },
  };
};
