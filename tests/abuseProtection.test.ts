import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { createEmailCooldown, hashRateLimitIdentifier } from '../src/middleware/abuseProtection.js';
import type { RedisClient } from '../src/lib/redis.js';

const keySecret = 'test-rate-limit-key-secret-123456';

const createRequest = (email = ' USER@Example.COM '): Request =>
  ({
    body: { email },
  }) as Request;

const createResponse = () => {
  const emitter = new EventEmitter();
  const state: {
    statusCode?: number;
    body?: unknown;
  } = {};

  const response = Object.assign(emitter, {
    status(statusCode: number) {
      response.statusCode = statusCode;
      state.statusCode = statusCode;
      return response;
    },
    statusCode: 200,
    json(body: unknown) {
      state.body = body;
      return response;
    },
  }) as unknown as Response & EventEmitter;

  return { response, state };
};

const createLogger = () => {
  const warnings: unknown[] = [];

  return {
    warnings,
    logger: {
      warn: ((data: object | string, message?: string) => {
        warnings.push({ data, message });
      }) as Logger['warn'],
    },
  };
};

const createRedisClient = (handler: RedisClient['call']): RedisClient =>
  ({
    call: handler,
    disconnect: () => undefined,
    ping: async () => 'PONG',
    quit: async () => 'OK',
  }) as RedisClient;

describe('abuse protection middleware', () => {
  test('hashes rate limit identifiers with normalized HMAC keys', () => {
    const first = hashRateLimitIdentifier(keySecret, ' USER@Example.COM ');
    const second = hashRateLimitIdentifier(keySecret, 'user@example.com');
    const differentSecret = hashRateLimitIdentifier(
      'another-rate-limit-key-secret-123',
      'user@example.com',
    );

    expect(first).toBe(second);
    expect(first).not.toContain('user@example.com');
    expect(first).not.toBe(differentSecret);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test('allows requests when Redis is not configured', async () => {
    const { response, state } = createResponse();
    const { logger } = createLogger();
    let nextCalled = false;

    const middleware = createEmailCooldown({
      redisClient: null,
      keyPrefix: 'email-cooldown:test',
      keySecret,
      ttlMs: 60_000,
      acceptedResponse: { message: 'Accepted' },
      getIdentifier: (req) => (typeof req.body.email === 'string' ? req.body.email : null),
      logger,
    });

    await middleware(createRequest(), response, (() => {
      nextCalled = true;
    }) as NextFunction);

    expect(nextCalled).toBe(true);
    expect(state.statusCode).toBeUndefined();
  });

  test('sets a Redis cooldown key after a successful response', async () => {
    const calls: unknown[][] = [];
    const redisClient = createRedisClient(async (...args: unknown[]) => {
      calls.push(args);
      return 'OK';
    });
    const { response, state } = createResponse();
    const { logger } = createLogger();
    let nextCalled = false;

    const middleware = createEmailCooldown({
      redisClient,
      keyPrefix: 'email-cooldown:test',
      keySecret,
      ttlMs: 60_000,
      acceptedResponse: { message: 'Accepted' },
      getIdentifier: (req) => (typeof req.body.email === 'string' ? req.body.email : null),
      logger,
    });

    await middleware(createRequest(), response, (() => {
      nextCalled = true;
    }) as NextFunction);

    expect(nextCalled).toBe(true);
    expect(state.statusCode).toBeUndefined();
    expect(calls).toEqual([
      [
        'set',
        expect.stringMatching(/^email-cooldown:test:[a-f0-9]{64}$/),
        expect.stringMatching(/^pending:/),
        'PX',
        '60000',
        'NX',
      ],
    ]);

    response.status(200).json({ message: 'Sent' });
    response.emit('finish');

    expect(calls).toEqual([
      [
        'set',
        expect.stringMatching(/^email-cooldown:test:[a-f0-9]{64}$/),
        expect.stringMatching(/^pending:/),
        'PX',
        '60000',
        'NX',
      ],
      ['set', calls[0]?.[1], 'active', 'PX', '60000'],
    ]);
  });

  test('does not set a Redis cooldown key after an unsuccessful response', async () => {
    const calls: unknown[][] = [];
    const redisClient = createRedisClient(async (...args: unknown[]) => {
      calls.push(args);
      return 'OK';
    });
    const { response } = createResponse();
    const { logger } = createLogger();
    let nextCalled = false;

    const middleware = createEmailCooldown({
      redisClient,
      keyPrefix: 'email-cooldown:test',
      keySecret,
      ttlMs: 60_000,
      acceptedResponse: { message: 'Accepted' },
      getIdentifier: (req) => (typeof req.body.email === 'string' ? req.body.email : null),
      logger,
    });

    await middleware(createRequest(), response, (() => {
      nextCalled = true;
    }) as NextFunction);

    response.status(500).json({ message: 'Failed' });
    response.emit('finish');

    expect(nextCalled).toBe(true);
    expect(calls[0]).toEqual([
      'set',
      expect.stringMatching(/^email-cooldown:test:[a-f0-9]{64}$/),
      expect.stringMatching(/^pending:/),
      'PX',
      '60000',
      'NX',
    ]);
    expect(calls[1]?.[0]).toBe('eval');
    expect(calls[1]?.[2]).toBe('1');
    expect(calls[1]?.[3]).toBe(calls[0]?.[1]);
    expect(calls[1]?.[4]).toBe(calls[0]?.[2]);
  });

  test('returns the accepted response during an active cooldown', async () => {
    const redisClient = createRedisClient(async () => null);
    const { response, state } = createResponse();
    const { logger } = createLogger();
    let nextCalled = false;

    const middleware = createEmailCooldown({
      redisClient,
      keyPrefix: 'email-cooldown:test',
      keySecret,
      ttlMs: 60_000,
      acceptedResponse: { message: 'Accepted' },
      getIdentifier: (req) => (typeof req.body.email === 'string' ? req.body.email : null),
      logger,
    });

    await middleware(createRequest(), response, (() => {
      nextCalled = true;
    }) as NextFunction);

    expect(nextCalled).toBe(false);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ message: 'Accepted' });
  });

  test('blocks concurrent requests while the first request is still in flight', async () => {
    const activeKeys = new Set<unknown>();
    const calls: unknown[][] = [];
    const redisClient = createRedisClient(async (...args: unknown[]) => {
      calls.push(args);

      if (args[0] === 'set' && args.at(-1) === 'NX') {
        const key = args[1];

        if (activeKeys.has(key)) {
          return null;
        }

        activeKeys.add(key);
        return 'OK';
      }

      if (args[0] === 'set') {
        activeKeys.add(args[1]);
        return 'OK';
      }

      return 0;
    });
    const { logger } = createLogger();
    const first = createResponse();
    const second = createResponse();
    let firstNextCalled = false;
    let secondNextCalled = false;

    const middleware = createEmailCooldown({
      redisClient,
      keyPrefix: 'email-cooldown:test',
      keySecret,
      ttlMs: 60_000,
      acceptedResponse: { message: 'Accepted' },
      getIdentifier: (req) => (typeof req.body.email === 'string' ? req.body.email : null),
      logger,
    });

    await middleware(createRequest(), first.response, (() => {
      firstNextCalled = true;
    }) as NextFunction);
    await middleware(createRequest('user@example.com'), second.response, (() => {
      secondNextCalled = true;
    }) as NextFunction);

    expect(firstNextCalled).toBe(true);
    expect(secondNextCalled).toBe(false);
    expect(second.state.statusCode).toBe(200);
    expect(second.state.body).toEqual({ message: 'Accepted' });
    expect(calls).toHaveLength(2);

    first.response.status(200).json({ message: 'Sent' });
    first.response.emit('finish');

    expect(calls[2]).toEqual(['set', calls[0]?.[1], 'active', 'PX', '60000']);
  });

  test('fails open and logs when the cooldown store is unavailable', async () => {
    const redisError = new Error('Redis unavailable');
    const redisClient = createRedisClient(async () => {
      throw redisError;
    });
    const { response, state } = createResponse();
    const { logger, warnings } = createLogger();
    let nextCalled = false;

    const middleware = createEmailCooldown({
      redisClient,
      keyPrefix: 'email-cooldown:test',
      keySecret,
      ttlMs: 60_000,
      acceptedResponse: { message: 'Accepted' },
      getIdentifier: (req) => (typeof req.body.email === 'string' ? req.body.email : null),
      logger,
    });

    await middleware(createRequest(), response, (() => {
      nextCalled = true;
    }) as NextFunction);

    expect(nextCalled).toBe(true);
    expect(state.statusCode).toBeUndefined();
    expect(warnings).toEqual([
      {
        data: { err: redisError },
        message: 'Email cooldown store unavailable, allowing request',
      },
    ]);
  });
});
