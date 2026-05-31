import crypto from 'node:crypto';
import type { CleanupSessionsResult } from '../services/auth.types.js';
import type { RedisClient } from '../lib/redis.js';

const SESSION_CLEANUP_LOCK_KEY = 'maintenance:session-cleanup:lock';
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end

return 0
`;

type SessionCleanupService = {
  cleanupSessions(input: {
    expiredBefore: Date;
    inactiveUpdatedBefore: Date;
  }): Promise<CleanupSessionsResult>;
};

type SessionCleanupLock = {
  release(): Promise<void>;
};

type SessionCleanupLockManager = {
  acquire(): Promise<SessionCleanupLock | null>;
};

type SessionCleanupJobDependencies = {
  authService: SessionCleanupService;
  clock: {
    now(): Date;
  };
  config: {
    intervalMs: number;
    inactiveRetentionMs: number;
  };
  lock?: SessionCleanupLockManager | null;
  logger: {
    error(data: object, message: string): void;
    info(data: object, message: string): void;
    warn(data: object, message: string): void;
  };
};

export type SessionCleanupJob = {
  runOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

export const createRedisSessionCleanupLock = ({
  redisClient,
  ttlMs,
  tokenFactory = () => crypto.randomUUID(),
}: {
  redisClient: Pick<RedisClient, 'call'>;
  ttlMs: number;
  tokenFactory?: () => string;
}): SessionCleanupLockManager => ({
  async acquire() {
    const token = tokenFactory();
    const result = await redisClient.call(
      'set',
      SESSION_CLEANUP_LOCK_KEY,
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
        await redisClient.call('eval', RELEASE_LOCK_SCRIPT, '1', SESSION_CLEANUP_LOCK_KEY, token);
      },
    };
  },
});

export const createSessionCleanupJob = ({
  authService,
  clock,
  config,
  lock,
  logger,
}: SessionCleanupJobDependencies): SessionCleanupJob => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentRun: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    if (currentRun) {
      return currentRun;
    }

    currentRun = (async () => {
      const now = clock.now();
      const inactiveUpdatedBefore = new Date(now.getTime() - config.inactiveRetentionMs);
      let acquiredLock: SessionCleanupLock | null = null;

      try {
        acquiredLock = lock ? await lock.acquire() : null;

        if (lock && !acquiredLock) {
          logger.info(
            { lockKey: SESSION_CLEANUP_LOCK_KEY },
            'Session cleanup skipped because another instance holds the lock',
          );
          return;
        }

        const result = await authService.cleanupSessions({
          expiredBefore: now,
          inactiveUpdatedBefore,
        });

        logger.info({ sessionsDeleted: result.sessionsDeleted }, 'Session cleanup completed');
      } catch (error) {
        logger.error({ err: error }, 'Session cleanup failed');
      } finally {
        if (acquiredLock) {
          await acquiredLock.release().catch((error: unknown) => {
            logger.warn({ err: error }, 'Session cleanup lock release failed');
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
        'Session cleanup scheduled',
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
