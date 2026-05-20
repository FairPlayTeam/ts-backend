import type { Server } from 'node:http';

import config from './config/env.js';
import { createApp } from './app.js';
import { authService } from './auth.instance.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { closeRedisClient } from './lib/redis.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = await createApp(config, { authService });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server started');
});

let isShuttingDown = false;

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

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');

  const timeout = setTimeout(() => {
    logger.fatal({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await closeServer(server);
    await prisma.$disconnect();
    await closeRedisClient();

    clearTimeout(timeout);
    logger.info('Graceful shutdown completed');
    process.exitCode = 0;
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

server.on('error', (error) => {
  logger.fatal({ err: error }, 'Server failed to start');
  process.exitCode = 1;
});
