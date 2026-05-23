import type { CleanupSessionsResult } from '../services/auth.types.js';

type SessionCleanupService = {
  cleanupSessions(input: {
    expiredBefore: Date;
    inactiveUpdatedBefore: Date;
  }): Promise<CleanupSessionsResult>;
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
  logger: {
    error(data: object, message: string): void;
    info(data: object, message: string): void;
  };
};

export type SessionCleanupJob = {
  runOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

export const createSessionCleanupJob = ({
  authService,
  clock,
  config,
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

      try {
        const result = await authService.cleanupSessions({
          expiredBefore: now,
          inactiveUpdatedBefore,
        });

        logger.info({ sessionsDeleted: result.sessionsDeleted }, 'Session cleanup completed');
      } catch (error) {
        logger.error({ err: error }, 'Session cleanup failed');
      } finally {
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
