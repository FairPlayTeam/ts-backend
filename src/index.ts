import type { Server } from 'node:http';

import config from './config/env.js';
import { createApp } from './app.js';
import { authService } from './auth.instance.js';
import { objectStorage } from './objectStorage.instance.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { closeRedisClient, createRedisClient, connectRedisClient } from './lib/redis.js';
import { createRedisAuthCleanupLock, createAuthCleanupJob } from './maintenance/authCleanup.js';
import { AUTH_CLEANUP_LOCK_TTL_MS } from './config/constants.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let redisClient = config.redisUrl ? createRedisClient(config.redisUrl, logger) : null;

if (redisClient && config.redisUrl) {
  try {
    await connectRedisClient(redisClient);
  } catch (err) {
    if (config.isProduction) {
      logger.fatal({ err }, 'Redis is required but unavailable at startup');
      throw err;
    }

    logger.warn({ err }, 'Redis unavailable at startup, falling back to in-memory rate limiting');
    redisClient.disconnect();
    redisClient = null;
  }
}

type ConfiguredObjectStorage = NonNullable<typeof objectStorage>;

const createObjectStorageReadinessCheck = (storage: ConfiguredObjectStorage) => ({
  objectStorage: async (): Promise<void> => {
    await storage.checkReady();
  },
});

const readinessChecks = {
  database: async (): Promise<void> => {
    await prisma.$queryRaw`SELECT 1`;
  },
  ...(redisClient && {
    redis: async (): Promise<void> => {
      await redisClient.ping();
    },
  }),
  ...(objectStorage ? createObjectStorageReadinessCheck(objectStorage) : {}),
};

const app = await createApp(config, { authService, redisClient, readinessChecks });
const authCleanupJob = createAuthCleanupJob({
  authService,
  clock: {
    now: () => new Date(),
  },
  config: {
    intervalMs: config.sessionCleanupIntervalMs,
    inactiveRetentionMs: config.sessionCleanupInactiveRetentionMs,
  },
  lock: redisClient
    ? createRedisAuthCleanupLock({
        redisClient,
        ttlMs: AUTH_CLEANUP_LOCK_TTL_MS,
      })
    : null,
  logger,
});

let isShuttingDown = false;
let server: Server | null = null;

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });

    server.closeIdleConnections?.();
  });

const closeServerIfListening = async (server: Server | null): Promise<void> => {
  if (!server?.listening) {
    return;
  }

  await closeServer(server);
};

const shutdown = async (reason: NodeJS.Signals | 'server_error', exitCode = 0): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info({ reason }, 'Graceful shutdown started');

  const timeout = setTimeout(() => {
    logger.fatal({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await authCleanupJob.stop();
    await closeServerIfListening(server);
    await prisma.$disconnect();
    await closeRedisClient(redisClient, logger);

    clearTimeout(timeout);
    logger.info('Graceful shutdown completed');
    process.exitCode = exitCode;
  } catch (error) {
    clearTimeout(timeout);
    logger.fatal({ err: error }, 'Graceful shutdown failed');
    // low level logging in case pino gets disconnected before the logs can arrive
    process.stderr.write('Graceful shutdown failed\n');
    process.exitCode = 1;
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

server = app.listen(config.port);

server.once('listening', () => {
  logger.info({ port: config.port }, 'Server started');
  authCleanupJob.start();
});

server.on('error', (error) => {
  logger.fatal({ err: error }, 'Server failed to start');
  void shutdown('server_error', 1);
});
