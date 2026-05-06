import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { createApp } from '../src/app.js';
import { HttpError } from '../src/errors/http.js';
import { errorHandler } from '../src/middleware/errors.js';
import { authRateLimitExceededHandler } from '../src/middleware/limiters.js';

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

const readError = async (response: Response): Promise<ErrorResponse> =>
  (await response.json()) as ErrorResponse;

const createMockResponse = () => {
  const state: {
    statusCode?: number;
    body?: unknown;
  } = {};

  const response = {
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
    process.env.DATABASE_URL ??= 'postgresql://user:password@localhost:5432/fairplay';
    process.env.BASE_URL ??= 'http://localhost:3000';

    const app = await createApp({
      allowedOrigins: [],
      baseUrl: 'http://localhost:3000/',
      isProduction: false,
      jsonBodyLimitBytes: 64,
      trustProxy: false,
    });

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
      message: 'Request body contains invalid JSON',
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
      message: 'Request body is too large',
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
      message: 'Request validation failed',
      details: [
        {
          field: 'body.email',
          message: 'Invalid input: expected string, received undefined',
        },
        {
          field: 'body.username',
          message: 'Invalid input: expected string, received undefined',
        },
        {
          field: 'body.password',
          message: 'Invalid input: expected string, received undefined',
        },
      ],
    });
  });

  test('keeps application 404 errors explicit', async () => {
    const response = await fetch(`${baseUrl}/missing-route`);

    expect(response.status).toBe(404);
    expect(await readError(response)).toEqual({
      error: 'NotFound',
      message: 'Route GET /missing-route not found',
    });
  });

  test('does not expose error details unless the error opts in', () => {
    const { response, state } = createMockResponse();

    errorHandler(
      new HttpError(400, 'BadRequest', 'Bad request', {
        details: [{ field: 'body.secret', message: 'hidden implementation detail' }],
      }),
      {} as Request,
      response,
      (() => undefined) as NextFunction,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({
      error: 'BadRequest',
      message: 'Bad request',
    });
  });

  test('passes rate limit failures through the global error pipeline', () => {
    let receivedError: unknown;
    const message = 'Too many auth attempts, please try again after 10 minutes.';

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
    expect((receivedError as HttpError).message).toBe(message);

    const { response, state } = createMockResponse();

    errorHandler(receivedError, {} as Request, response, (() => undefined) as NextFunction);

    expect(state.statusCode).toBe(429);
    expect(state.body).toEqual({
      error: 'TooManyRequests',
      message,
    });
  });
});
