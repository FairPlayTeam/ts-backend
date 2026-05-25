import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { createStubAuthService } from './support/auth.js';

let server: Server;
let baseUrl: string;
let receivedSessionKey: string | undefined;
let receivedProfileUpdate: unknown;
let receivedPasswordResetRequest: unknown;
let receivedGetSessionsRequest: unknown;

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
          updateProfile: async (input) => {
            receivedProfileUpdate = input;
            return authService.updateProfile(input);
          },
          requestPasswordReset: async (input) => {
            receivedPasswordResetRequest = input;
            return authService.requestPasswordReset(input);
          },
          getUserSessions: async (input) => {
            receivedGetSessionsRequest = input;
            return authService.getUserSessions(input);
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
        displayName: 'Fairplay User',
        bio: 'Definitely not an undercover Y**tube employee.',
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

  test('updates the current user profile for a valid bearer session', async () => {
    receivedProfileUpdate = undefined;

    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer test-session-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        displayName: ' Updated Name ',
        bio: null,
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedProfileUpdate).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      displayName: 'Updated Name',
      bio: null,
    });
    expect(await response.json()).toEqual({
      message: 'Profile updated successfully',
      user: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Updated Name',
        bio: null,
        role: 'user',
      },
    });
  });

  test('rejects empty profile update payloads', async () => {
    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer test-session-key',
        'content-type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: 'Request validation failed',
      details: [
        {
          field: 'body',
          message: 'At least one profile field must be provided',
        },
      ],
    });
  });

  test('requires a bearer session to update the current user profile', async () => {
    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        displayName: 'Updated Name',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Bearer session token is required',
    });
  });

  test('requests password reset without requiring a bearer session', async () => {
    receivedPasswordResetRequest = undefined;

    const response = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: ' USER@Example.COM ',
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedPasswordResetRequest).toEqual({
      email: 'user@example.com',
    });
    expect(await response.json()).toEqual({
      message:
        'If this email exists and is eligible for password reset, a reset link has been sent.',
    });
  });

  test('rejects password reset requests from authenticated users', async () => {
    const response = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-session-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'user@example.com',
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Conflict',
      message: 'Already authenticated users cannot request a password reset',
    });
  });

  test('returns active sessions for a valid bearer session', async () => {
    receivedGetSessionsRequest = undefined;

    const response = await fetch(
      `${baseUrl}/auth/sessions?limit=10&cursorLastUsedAt=2026-01-01T00%3A00%3A00.000Z&cursorId=0d4e55cb-c278-4d74-a192-bf7c10888c7a`,
      {
        headers: {
          authorization: 'Bearer test-session-key',
        },
      },
    );

    expect(receivedGetSessionsRequest).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      currentSessionId: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
      limit: 10,
      cursor: {
        lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
        id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
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
      nextCursor: {
        lastUsedAt: '2026-01-01T00:00:00.000Z',
        id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
      },
      total: 1,
    });
  });

  test('rejects malformed active session pagination cursors', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions?cursorLastUsedAt=not-a-date`, {
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: 'Request validation failed',
      details: [
        {
          field: 'query.cursorLastUsedAt',
          message: 'Invalid ISO datetime',
        },
        {
          field: 'query',
          message: 'cursorLastUsedAt and cursorId must be provided together',
        },
      ],
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

  test('logs out a specific session for a valid bearer session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/123e4567-e89b-12d3-a456-426614174000`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Session logged out successfully',
      sessionsLoggedOut: 1,
    });
  });

  test('rejects malformed session ids when logging out a specific session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/not-a-session-id`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: 'Request validation failed',
      details: [
        {
          field: 'params.sessionId',
          message: 'Session id must be a valid UUID',
        },
      ],
    });
  });

  test('requires a bearer session to log out a specific session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/123e4567-e89b-12d3-a456-426614174000`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Bearer session token is required',
    });
  });
});
