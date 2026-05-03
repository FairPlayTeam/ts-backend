import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';

type ErrorResponse = {
  error: string;
  message: string;
};

let server: Server;
let baseUrl: string;

const readError = async (response: Response): Promise<ErrorResponse> =>
  (await response.json()) as ErrorResponse;

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

  test('keeps application 404 errors explicit', async () => {
    const response = await fetch(`${baseUrl}/missing-route`);

    expect(response.status).toBe(404);
    expect(await readError(response)).toEqual({
      error: 'NotFound',
      message: 'Route GET /missing-route not found',
    });
  });
});
