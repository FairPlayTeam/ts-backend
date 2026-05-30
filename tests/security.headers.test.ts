import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { createStubAuthService } from './support/auth.js';

let server: Server;
let baseUrl: string;

describe('security headers', () => {
  beforeAll(async () => {
    const app = await createApp(
      {
        allowedOrigins: [],
        baseUrl: 'http://localhost:3000/',
        isProduction: false,
        jsonBodyLimitBytes: 1024 * 1024,
        rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
        trustProxy: false,
      },
      { authService: createStubAuthService() },
    );

    server = app.listen(0);
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind to a TCP port');
    }

    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  });

  test('keeps CSP on API routes while disabling it for Swagger UI', async () => {
    const apiResponse = await fetch(`${baseUrl}/auth/me`);
    const docsResponse = await fetch(`${baseUrl}/docs/`);

    expect(apiResponse.headers.get('content-security-policy')).toBeTruthy();
    expect(apiResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(docsResponse.headers.get('content-security-policy')).toBeNull();
    expect(docsResponse.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
