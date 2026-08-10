import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { createApp } from '../src/app.js';
import { HttpError, REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { logger } from '../src/lib/logger.js';
import {
  INVALID_JSON_MESSAGE,
  REQUEST_BODY_TOO_LARGE_MESSAGE,
  createRouteNotFoundMessage,
  errorHandler,
} from '../src/middleware/errors.js';
import {
  AUTH_RATE_LIMIT_MESSAGE,
  authRateLimitExceededHandler,
} from '../src/middleware/limiters.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideosService } from './support/videos.js';

type ErrorResponse = {
  error: string;
  message: string;
  details?: {
    field: string;
    message: string;
  }[];
};

let server: Server;
let baseUrl: string;

const missingRoutePath = '/missing-route';
const missingStringValidationMessage = 'Invalid input: expected string, received undefined';
const hiddenBadRequestMessage = 'Bad request';
const hiddenErrorDetailMessage = 'hidden implementation detail';

const readError = async (response: Response): Promise<ErrorResponse> =>
  (await response.json()) as ErrorResponse;

const createMockResponse = () => {
  const state: {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = { headers: {} };

  const response = {
    set(field: string, value: string) {
      state.headers[field] = value;
      return response;
    },
    status(statusCode: number) {
      state.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  } as unknown as ExpressResponse;

  return { response, state };
};

describe('error handling', () => {
  beforeAll(async () => {
    const app = await createApp(
      {
        allowedOrigins: [],
        profileMediaMaxUploadBytes: 3 * 1024 * 1024,
        baseUrl: 'http://localhost:3000/',
        isProduction: false,
        jsonBodyLimitBytes: 64,
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

  test('returns 400 for malformed JSON request bodies', async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":',
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toEqual({
      error: 'InvalidJson',
      message: INVALID_JSON_MESSAGE,
    });
  });

  test('returns 413 for request bodies above the configured limit', async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        username: 'fairplay_user',
        password: 'Password1!',
      }),
    });

    expect(response.status).toBe(413);
    expect(await readError(response)).toEqual({
      error: 'PayloadTooLarge',
      message: REQUEST_BODY_TOO_LARGE_MESSAGE,
    });
  });

  test('returns validation details through the global error handler', async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'body.email',
          message: missingStringValidationMessage,
        },
        {
          field: 'body.username',
          message: missingStringValidationMessage,
        },
        {
          field: 'body.password',
          message: missingStringValidationMessage,
        },
      ],
    });
  });

  test('keeps application 404 errors explicit', async () => {
    const response = await fetch(`${baseUrl}${missingRoutePath}`);

    expect(response.status).toBe(404);
    expect(await readError(response)).toEqual({
      error: 'NotFound',
      message: createRouteNotFoundMessage('GET', missingRoutePath),
    });
  });

  test('does not expose error details unless the error opts in', () => {
    const { response, state } = createMockResponse();

    errorHandler(
      new HttpError(400, 'BadRequest', hiddenBadRequestMessage, {
        details: [{ field: 'body.secret', message: hiddenErrorDetailMessage }],
      }),
      {} as Request,
      response,
      (() => undefined) as NextFunction,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({
      error: 'BadRequest',
      message: hiddenBadRequestMessage,
    });
  });

  test('passes rate limit failures through the global error pipeline', () => {
    let receivedError: unknown;

    authRateLimitExceededHandler(
      {} as Request,
      {} as ExpressResponse,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedError).toBeInstanceOf(HttpError);
    expect((receivedError as HttpError).statusCode).toBe(429);
    expect((receivedError as HttpError).code).toBe('TooManyRequests');
    expect((receivedError as HttpError).message).toBe(AUTH_RATE_LIMIT_MESSAGE);

    const { response, state } = createMockResponse();

    errorHandler(receivedError, {} as Request, response, (() => undefined) as NextFunction);

    expect(state.statusCode).toBe(429);
    expect(state.body).toEqual({
      error: 'TooManyRequests',
      message: AUTH_RATE_LIMIT_MESSAGE,
    });
  });

  test('marks every global error response as non-cacheable', () => {
    const loggerError = spyOn(logger, 'error').mockImplementation(() => logger);

    try {
      for (const [statusCode, code] of [
        [400, 'BadRequest'],
        [404, 'NotFound'],
        [409, 'Conflict'],
        [429, 'TooManyRequests'],
        [500, 'InternalServerError'],
        [503, 'ServiceUnavailable'],
      ] as const) {
        const { response, state } = createMockResponse();

        errorHandler(
          new HttpError(statusCode, code, 'Expected test error'),
          {} as Request,
          response,
          (() => undefined) as NextFunction,
        );

        expect(state.statusCode).toBe(statusCode);
        expect(state.headers['Cache-Control']).toBe('no-store');
      }
    } finally {
      loggerError.mockRestore();
    }
  });

  test('logs streaming failures structurally after response headers were sent', () => {
    const error = new Error('database page failed during streaming');
    const loggerError = spyOn(logger, 'error').mockImplementation(() => logger);
    let forwardedError: unknown;

    errorHandler(
      error,
      {} as Request,
      { headersSent: true } as ExpressResponse,
      ((err?: unknown) => {
        forwardedError = err;
      }) as NextFunction,
    );

    expect(loggerError).toHaveBeenCalledWith(
      { err: error },
      'Request failed after response headers were sent',
    );
    expect(forwardedError).toBe(error);
    loggerError.mockRestore();
  });
});
