import type { Server } from 'node:http';

import config from './config/env.js';
import { createApp } from './app.js';
import { adminService } from './admin.instance.js';
import { authService } from './auth.instance.js';
import { profilesService } from './profiles.instance.js';
import { videosService } from './videos.instance.js';
import { objectStorage, videoObjectStorage } from './objectStorage.instance.js';
import { logger } from './lib/logger.js';
import type { ObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { closeRedisClient, createRedisClient, connectRedisClient } from './lib/redis.js';
import {
  createMaintenanceCleanupJob,
  createRedisMaintenanceCleanupLock,
} from './maintenance/cleanup.js';
import { MAINTENANCE_CLEANUP_LOCK_TTL_MS } from './config/constants.js';
import { createVideoTranscodeRunner } from './services/videos/videoTranscodeRunner.js';
import { runRuntimeShutdownSteps } from './runtimeShutdown.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

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

const configuredObjectStorages = [objectStorage, videoObjectStorage].filter(
  (storage): storage is ObjectStorage => storage !== null,
);

const readinessChecks = {
  database: async (): Promise<void> => {
    await prisma.$queryRaw`SELECT 1`;
  },
  ...(redisClient && {
    redis: async (): Promise<void> => {
      await redisClient.ping();
    },
  }),
  ...(configuredObjectStorages.length > 0
    ? {
        objectStorage: async (): Promise<void> => {
          await Promise.all(configuredObjectStorages.map((storage) => storage.checkReady()));
        },
      }
    : {}),
};

const app = await createApp(config, {
  adminService,
  authService,
  profilesService,
  videosService,
  redisClient,
  readinessChecks,
});
const maintenanceCleanupJob = createMaintenanceCleanupJob({
  authService,
  videosService,
  clock: {
    now: () => new Date(),
  },
  config: {
    intervalMs: config.sessionCleanupIntervalMs,
    inactiveRetentionMs: config.sessionCleanupInactiveRetentionMs,
  },
  lock: redisClient
    ? createRedisMaintenanceCleanupLock({
        redisClient,
        ttlMs: MAINTENANCE_CLEANUP_LOCK_TTL_MS,
      })
    : null,
  logger,
});
const videoTranscodeRunner = videoObjectStorage
  ? createVideoTranscodeRunner({
      prisma,
      objectStorage: videoObjectStorage,
      clock: {
        now: () => new Date(),
      },
      config: config.videoTranscode,
      logger,
    })
  : null;

let isShuttingDown = false;
let server: Server | null = null;

const closeServerIfListening = async (server: Server | null): Promise<void> => {
  if (!server?.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });

    server.closeIdleConnections?.();
  });
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
    const failedSteps = await runRuntimeShutdownSteps(
      [
        {
          name: 'maintenance',
          run: () => maintenanceCleanupJob.stop(),
        },
        {
          name: 'transcodes',
          run: () => videoTranscodeRunner?.stop() ?? Promise.resolve(),
        },
        {
          name: 'httpServer',
          run: () => closeServerIfListening(server),
        },
        {
          name: 'prisma',
          run: () => prisma.$disconnect(),
        },
        {
          name: 'redis',
          run: () => closeRedisClient(redisClient, logger),
        },
      ],
      logger,
    );

    clearTimeout(timeout);
    if (failedSteps.length > 0) {
      logger.fatal({ failedSteps }, 'Graceful shutdown completed with failures');
      process.stderr.write('Graceful shutdown completed with failures\n');
      process.exitCode = 1;
    } else {
      logger.info('Graceful shutdown completed');
      process.exitCode = exitCode;
    }
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
  maintenanceCleanupJob.start();
  videoTranscodeRunner?.start();
});

server.on('error', (error) => {
  logger.fatal({ err: error }, 'Server failed to start');
  void shutdown('server_error', 1);
});
