import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { createStubAuthService } from './support/auth.js';

let server: Server;
let baseUrl: string;
let receivedSessionKey: string | undefined;

describe('auth routes', () => {
  beforeAll(async () => {
    const authService = createStubAuthService();
    const app = await createApp(
      {
        allowedOrigins: [],
        baseUrl: 'http://localhost:3000/',
        isProduction: false,
        jsonBodyLimitBytes: 1024 * 1024,
        trustProxy: false,
      },
      {
        authService: {
          ...authService,
          validateSession: async (sessionKey) => {
            receivedSessionKey = sessionKey;
            return authService.validateSession(sessionKey);
          },
        },
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

  test('returns the current user for a valid bearer session', async () => {
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    const observedSessionKey = receivedSessionKey as string | undefined;
    expect(observedSessionKey).toBe('test-session-key');
    expect(await response.json()).toEqual({
      user: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        email: 'user@example.com',
        username: 'fairplay_user',
        role: 'user',
      },
      session: {
        id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
        expiresAt: '2026-01-31T00:00:00.000Z',
      },
    });
  });

  test('requires a bearer session for the current user route', async () => {
    const response = await fetch(`${baseUrl}/auth/me`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Bearer session token is required',
    });
  });

  test('returns active sessions for a valid bearer session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions`, {
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [
        {
          id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
          sessionKeySuffix: 'sion-key',
          ipAddress: '127.0.0.1',
          userAgent: 'bun-test',
          deviceInfo: 'bun-test',
          isCurrent: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-31T00:00:00.000Z',
        },
      ],
      total: 1,
    });
  });

  test('requires a bearer session for the active sessions route', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Bearer session token is required',
    });
  });

  test('logs out all sessions for a valid bearer session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/all`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'All sessions logged out successfully',
      sessionsLoggedOut: 1,
    });
  });

  test('requires a bearer session to log out all sessions', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/all`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Bearer session token is required',
    });
  });

  test('logs out other sessions for a valid bearer session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/others/all`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Other sessions logged out successfully',
      sessionsLoggedOut: 1,
    });
  });

  test('requires a bearer session to log out other sessions', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/others/all`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Bearer session token is required',
    });
  });
});
