import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';

type TestServer = {
  baseUrl: string;
  server: Server;
};

const createTestServer = async (
  readinessChecks?: {
    database(): Promise<void>;
    redis?(): Promise<void>;
    objectStorage?(): Promise<void>;
  } | null,
): Promise<TestServer> => {
  const app = await createApp(
    {
      allowedOrigins: [],
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
      baseUrl: 'http://localhost:3000/',
      isProduction: false,
      jsonBodyLimitBytes: 1024 * 1024,
      rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
      trustProxy: false,
    },
    {
      adminService: createStubAdminService(),
      authService: createStubAuthService(),
      ...(readinessChecks !== undefined ? { readinessChecks } : {}),
    },
  );

  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
  };
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
};

let currentServer: Server | null = null;

describe('health routes', () => {
  afterEach(async () => {
    if (!currentServer) {
      return;
    }

    await closeServer(currentServer);
    currentServer = null;
  });

  test('returns liveness without checking dependencies', async () => {
    const { baseUrl, server } = await createTestServer({
      database: async () => {
        throw new Error('Database should not be checked by liveness');
      },
      redis: async () => {
        throw new Error('Redis should not be checked by liveness');
      },
      objectStorage: async () => {
        throw new Error('Object storage should not be checked by liveness');
      },
    });
    currentServer = server;

    const response = await fetch(`${baseUrl}/health/live`);
    const body = (await response.json()) as { status: string; uptime: number };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  test('returns ready when all dependencies are healthy', async () => {
    const { baseUrl, server } = await createTestServer({
      database: async () => undefined,
      redis: async () => undefined,
      objectStorage: async () => undefined,
    });
    currentServer = server;

    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      services: {
        database: 'ok',
        redis: 'ok',
        objectStorage: 'ok',
      },
    });
  });

  test('returns ready when optional redis is not configured', async () => {
    const { baseUrl, server } = await createTestServer({
      database: async () => undefined,
    });
    currentServer = server;

    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      services: {
        database: 'ok',
      },
    });
  });

  test('returns unavailable when a dependency is unhealthy', async () => {
    const { baseUrl, server } = await createTestServer({
      database: async () => undefined,
      redis: async () => {
        throw new Error('Redis unavailable');
      },
    });
    currentServer = server;

    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'error',
      services: {
        database: 'ok',
        redis: 'error',
      },
    });
  });

  test('returns unavailable when object storage is unhealthy', async () => {
    const { baseUrl, server } = await createTestServer({
      database: async () => undefined,
      objectStorage: async () => {
        throw new Error('Object storage unavailable');
      },
    });
    currentServer = server;

    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'error',
      services: {
        database: 'ok',
        objectStorage: 'error',
      },
    });
  });
});
