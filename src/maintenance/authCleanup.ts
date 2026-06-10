import crypto from 'node:crypto';
import type { AuthService } from '../services/auth.types.js';
import type { RedisClient } from '../lib/redis.js';

const AUTH_CLEANUP_LOCK_KEY = 'maintenance:auth-cleanup:lock';
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end

return 0
`;

type AuthCleanupService = Pick<
  AuthService,
  'cleanupExpiredAuthTokens' | 'cleanupPendingUserMediaDeletions' | 'cleanupSessions'
>;

type AuthCleanupLock = {
  release(): Promise<void>;
};

type AuthCleanupLockManager = {
  acquire(): Promise<AuthCleanupLock | null>;
};

type AuthCleanupJobDependencies = {
  authService: AuthCleanupService;
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

export type AuthCleanupJob = {
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

        const result = await authService.cleanupSessions({
          expiredBefore: now,
          inactiveUpdatedBefore,
        });

        const tokenResult = await authService.cleanupExpiredAuthTokens({
          expiredBefore: now,
        });

        const mediaDeletionResult = await authService.cleanupPendingUserMediaDeletions({
          pendingBefore: now,
        });

        logger.info(
          {
            sessionsDeleted: result.sessionsDeleted,
            emailVerificationTokensDeleted: tokenResult.emailVerificationTokensDeleted,
            passwordResetTokensDeleted: tokenResult.passwordResetTokensDeleted,
            mediaObjectsDeleted: mediaDeletionResult.mediaObjectsDeleted,
            mediaObjectDeletionJobsFailed: mediaDeletionResult.mediaObjectDeletionJobsFailed,
          },
          'Auth cleanup completed',
        );
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
