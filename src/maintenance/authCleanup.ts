import crypto from 'node:crypto';
import type { AuthMaintenancePort } from '../services/auth.types.js';
import type { RedisClient } from '../lib/redis.js';

const AUTH_CLEANUP_LOCK_KEY = 'maintenance:auth-cleanup:lock';
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end

return 0
`;

type AuthCleanupLock = {
  release(): Promise<void>;
};

type AuthCleanupLockManager = {
  acquire(): Promise<AuthCleanupLock | null>;
};

type AuthCleanupJobDependencies = {
  authService: AuthMaintenancePort;
  clock: {
    now(): Date;
  };
  config: {
    intervalMs: number;
    inactiveRetentionMs: number;
  };
  lock?: AuthCleanupLockManager | null;
  logger: {
    error(data: object, message: string): void;
    info(data: object, message: string): void;
    warn(data: object, message: string): void;
  };
};

type AuthCleanupSummary = Partial<{
  sessionsDeleted: number;
  emailVerificationTokensDeleted: number;
  passwordResetTokensDeleted: number;
  mediaObjectsDeleted: number;
  mediaObjectDeletionJobsFailed: number;
}>;

type AuthCleanupStep = 'authTokens' | 'sessions' | 'userMediaDeletionJobs';

type AuthCleanupJob = {
  runOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

export const createRedisAuthCleanupLock = ({
  redisClient,
  ttlMs,
  tokenFactory = () => crypto.randomUUID(),
}: {
  redisClient: Pick<RedisClient, 'call'>;
  ttlMs: number;
  tokenFactory?: () => string;
}): AuthCleanupLockManager => ({
  async acquire() {
    const token = tokenFactory();
    const result = await redisClient.call(
      'set',
      AUTH_CLEANUP_LOCK_KEY,
      token,
      'PX',
      String(ttlMs),
      'NX',
    );

    if (result !== 'OK') {
      return null;
    }

    return {
      async release() {
        await redisClient.call('eval', RELEASE_LOCK_SCRIPT, '1', AUTH_CLEANUP_LOCK_KEY, token);
      },
    };
  },
});

export const createAuthCleanupJob = ({
  authService,
  clock,
  config,
  lock,
  logger,
}: AuthCleanupJobDependencies): AuthCleanupJob => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentRun: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    if (currentRun) {
      return currentRun;
    }

    currentRun = (async () => {
      const now = clock.now();
      const inactiveUpdatedBefore = new Date(now.getTime() - config.inactiveRetentionMs);
      let acquiredLock: AuthCleanupLock | null = null;

      try {
        acquiredLock = lock ? await lock.acquire() : null;

        if (lock && !acquiredLock) {
          logger.info(
            { lockKey: AUTH_CLEANUP_LOCK_KEY },
            'Auth cleanup skipped because another instance holds the lock',
          );
          return;
        }

        const summary: AuthCleanupSummary = {};
        const failedCleanupSteps: AuthCleanupStep[] = [];
        const runCleanupStep = async <T>({
          cleanupStep,
          run,
          updateSummary,
        }: {
          cleanupStep: AuthCleanupStep;
          run: () => Promise<T>;
          updateSummary: (result: T) => void;
        }): Promise<void> => {
          try {
            updateSummary(await run());
          } catch (error) {
            failedCleanupSteps.push(cleanupStep);
            logger.error({ err: error, cleanupStep }, 'Auth cleanup step failed');
          }
        };

        await runCleanupStep({
          cleanupStep: 'sessions',
          run: () =>
            authService.cleanupSessions({
              expiredBefore: now,
              inactiveUpdatedBefore,
            }),
          updateSummary: (result) => {
            summary.sessionsDeleted = result.sessionsDeleted;
          },
        });

        await runCleanupStep({
          cleanupStep: 'authTokens',
          run: () =>
            authService.cleanupExpiredAuthTokens({
              expiredBefore: now,
            }),
          updateSummary: (result) => {
            summary.emailVerificationTokensDeleted = result.emailVerificationTokensDeleted;
            summary.passwordResetTokensDeleted = result.passwordResetTokensDeleted;
          },
        });

        await runCleanupStep({
          cleanupStep: 'userMediaDeletionJobs',
          run: () =>
            authService.cleanupPendingUserMediaDeletions({
              pendingBefore: now,
            }),
          updateSummary: (result) => {
            summary.mediaObjectsDeleted = result.mediaObjectsDeleted;
            summary.mediaObjectDeletionJobsFailed = result.mediaObjectDeletionJobsFailed;
          },
        });

        if (failedCleanupSteps.length > 0) {
          logger.warn(
            {
              ...summary,
              failedCleanupSteps,
            },
            'Auth cleanup completed with failures',
          );
          return;
        }

        logger.info(summary, 'Auth cleanup completed');
      } catch (error) {
        logger.error({ err: error }, 'Auth cleanup failed');
      } finally {
        if (acquiredLock) {
          await acquiredLock.release().catch((error: unknown) => {
            logger.warn({ err: error }, 'Auth cleanup lock release failed');
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
        'Auth cleanup scheduled',
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
