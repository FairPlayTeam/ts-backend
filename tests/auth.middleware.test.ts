import { describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import { createAuthenticateSession, type AuthenticatedRequest } from '../src/middleware/auth.js';
import { HttpError } from '../src/errors/http.js';

const sessionResult = {
  user: {
    id: 'user-id',
    email: 'user@example.com',
    username: 'fairplay_user',
    displayName: 'Fairplay User',
    bio: 'Definitely not an undercover Y**tube employee.',
    role: 'user',
  },
  session: {
    id: 'session-id',
    expiresAt: new Date('2026-01-31T00:00:00.000Z'),
  },
};

const createRequest = (authorization?: string): Request =>
  ({
    headers: authorization === undefined ? {} : { authorization },
  }) as Request;

describe('auth session middleware', () => {
  test('authenticates bearer sessions and attaches user context', async () => {
    let receivedSessionKey: string | undefined;
    let receivedError: unknown;
    const req = createRequest('Bearer plain-session-token');
    const authenticateSession = createAuthenticateSession({
      authService: {
        validateSession: async (sessionKey) => {
          receivedSessionKey = sessionKey;
          return sessionResult;
        },
      },
    });

    await authenticateSession(
      req,
      {} as Response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedSessionKey).toBe('plain-session-token');
    expect(receivedError).toBeUndefined();
    expect((req as AuthenticatedRequest).user).toEqual(sessionResult.user);
    expect((req as AuthenticatedRequest).session).toEqual(sessionResult.session);
  });

  test('rejects missing bearer tokens through the error pipeline', async () => {
    let receivedError: unknown;
    const authenticateSession = createAuthenticateSession({
      authService: {
        validateSession: async () => {
          throw new Error('Should not validate missing bearer tokens');
        },
      },
    });

    await authenticateSession(
      createRequest(),
      {} as Response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedError).toBeInstanceOf(HttpError);
    expect((receivedError as HttpError).statusCode).toBe(401);
    expect((receivedError as HttpError).code).toBe('Unauthorized');
    expect((receivedError as HttpError).message).toBe('Bearer session token is required');
  });

  test('rejects malformed bearer headers before validating sessions', async () => {
    let receivedError: unknown;
    const authenticateSession = createAuthenticateSession({
      authService: {
        validateSession: async () => {
          throw new Error('Should not validate malformed bearer tokens');
        },
      },
    });

    await authenticateSession(
      createRequest('Bearer token with spaces'),
      {} as Response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedError).toBeInstanceOf(HttpError);
    expect((receivedError as HttpError).statusCode).toBe(401);
    expect((receivedError as HttpError).code).toBe('Unauthorized');
    expect((receivedError as HttpError).message).toBe('Bearer session token is required');
  });

  test('rejects invalid sessions through the error pipeline', async () => {
    let receivedError: unknown;
    const authenticateSession = createAuthenticateSession({
      authService: {
        validateSession: async () => null,
      },
    });

    await authenticateSession(
      createRequest('Bearer invalid-token'),
      {} as Response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedError).toBeInstanceOf(HttpError);
    expect((receivedError as HttpError).statusCode).toBe(401);
    expect((receivedError as HttpError).code).toBe('Unauthorized');
    expect((receivedError as HttpError).message).toBe('Invalid or expired session');
  });

  test('passes unexpected validation failures to the global error handler', async () => {
    const validationError = new Error('Database unavailable');
    let receivedError: unknown;
    const authenticateSession = createAuthenticateSession({
      authService: {
        validateSession: async () => {
          throw validationError;
        },
      },
    });

    await authenticateSession(
      createRequest('Bearer plain-session-token'),
      {} as Response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedError).toBe(validationError);
  });
});
