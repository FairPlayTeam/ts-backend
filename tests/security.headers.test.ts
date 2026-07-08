import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { ALL_CORS_ORIGINS } from '../src/config/env.parsers.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideosService } from './support/videos.js';

let server: Server;
let baseUrl: string;

describe('security headers', () => {
  beforeAll(async () => {
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
        profilesService: createStubProfilesService(),
        videosService: createStubVideosService(),
      },
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

  test('allows public CORS origins without credentialed requests', async () => {
    const app = await createApp(
      {
        allowedOrigins: ALL_CORS_ORIGINS,
        profileMediaMaxUploadBytes: 3 * 1024 * 1024,
        baseUrl: 'http://localhost:3000/',
        isProduction: true,
        jsonBodyLimitBytes: 1024 * 1024,
        rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
        trustProxy: false,
      },
      {
        adminService: createStubAdminService(),
        authService: createStubAuthService(),
        profilesService: createStubProfilesService(),
        videosService: createStubVideosService(),
      },
    );

    const corsServer = app.listen(0);
    const address = corsServer.address();

    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind to a TCP port');
    }

    try {
      const corsBaseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
      const response = await fetch(`${corsBaseUrl}/health`, {
        headers: {
          origin: 'https://community-frontend.example',
        },
      });

      expect(response.headers.get('access-control-allow-origin')).toBe(
        'https://community-frontend.example',
      );
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        corsServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });
    }
  });
});
