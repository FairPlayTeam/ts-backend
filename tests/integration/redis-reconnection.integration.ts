import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

import express from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import { expect, test } from 'vitest';

import { closeRedisClient, connectRedisClient, createRedisClient } from '../../src/lib/redis.js';
import { createRouter as createHealthRouter } from '../../src/routes/health.js';
import { testLogger } from './support/logger.js';
import { buildRedisTestUrl, startRedisTestContainer } from './support/redis.js';

const REDIS_TRANSITION_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

const waitForRedisEvent = (client: Redis, event: 'ready' | 'reconnecting'): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      client.removeListener(event, onExpectedEvent);
      client.removeListener('end', onEnd);
    };
    const onExpectedEvent = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`Redis reached end while waiting for ${event}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Redis ${event}`));
    }, REDIS_TRANSITION_TIMEOUT_MS);

    client.once(event, onExpectedEvent);
    client.once('end', onEnd);
  });

const runDockerContainerCommand = async (
  command: 'start' | 'stop',
  containerId: string,
): Promise<void> => {
  try {
    await execFileAsync('docker', [command, containerId]);
  } catch (error) {
    throw new Error(`Failed to ${command} the Redis test container`, { cause: error });
  }
};

// Docker Desktop can remap a dynamically published port across stop/start. This test accepts the
// short probe-to-bind race of a fixed test port instead of adding a dedicated TCP proxy.
const getAvailableHostPort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a host port for the Redis test container'));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });

test('recovers readiness with the same client after a real Redis stop and restart', async () => {
  let container: StartedTestContainer | null = null;
  let containerStopped = false;
  let redisClient: Redis | null = null;

  try {
    const hostPort = await getAvailableHostPort();
    container = await startRedisTestContainer({ hostPort });
    const client = createRedisClient(buildRedisTestUrl(container), testLogger);
    redisClient = client;
    await connectRedisClient(client);

    const app = express();
    app.use(
      '/health',
      createHealthRouter({
        readinessChecks: {
          database: async () => undefined,
          redis: async () => {
            await client.ping();
          },
        },
      }),
    );

    await request(app)
      .get('/health/ready')
      .expect(200, {
        status: 'ok',
        services: {
          database: 'ok',
          redis: 'ok',
        },
      });

    const reconnecting = waitForRedisEvent(client, 'reconnecting');
    await runDockerContainerCommand('stop', container.getId());
    containerStopped = true;
    await reconnecting;

    await expect(client.ping()).rejects.toThrow();
    await request(app)
      .get('/health/ready')
      .expect(503, {
        status: 'error',
        services: {
          database: 'ok',
          redis: 'error',
        },
      });

    const ready = waitForRedisEvent(client, 'ready');
    await runDockerContainerCommand('start', container.getId());
    containerStopped = false;
    await ready;

    await expect(client.ping()).resolves.toBe('PONG');
    await request(app)
      .get('/health/ready')
      .expect(200, {
        status: 'ok',
        services: {
          database: 'ok',
          redis: 'ok',
        },
      });
  } finally {
    if (container && containerStopped) {
      await runDockerContainerCommand('start', container.getId());
    }
    await closeRedisClient(redisClient, testLogger);
    await container?.stop();
  }
}, 60_000);
