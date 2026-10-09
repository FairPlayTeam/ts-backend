import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express, { type ErrorRequestHandler } from 'express';
import { mapHandlerErrors } from '../src/shared/http/mapHandlerErrors.js';

let server: Server;
let baseUrl: string;

const mapError = (error: unknown): Error =>
  new Error(`mapped: ${error instanceof Error ? error.message : 'unknown error'}`);

describe('mapHandlerErrors', () => {
  beforeAll(async () => {
    const app = express();

    app.get(
      '/sync',
      mapHandlerErrors(mapError, () => {
        throw new Error('sync failure');
      }),
    );
    app.get(
      '/async',
      mapHandlerErrors(mapError, async () => {
        throw new Error('async failure');
      }),
    );

    const errorHandler: ErrorRequestHandler = (error, _req, res, _next) =>
      res
        .status(500)
        .json({ message: error instanceof Error ? error.message : 'unexpected error' });
    app.use(errorHandler);

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected the mapHandlerErrors test server to listen on a TCP port');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test.each([
    ['sync', 'mapped: sync failure'],
    ['async', 'mapped: async failure'],
  ])('maps %s handler errors before forwarding them', async (path, message) => {
    const response = await fetch(`${baseUrl}/${path}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message });
  });
});
