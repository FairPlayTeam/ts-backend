import { describe, expect, test } from 'bun:test';

import { createRedisClient, getRedisReconnectDelayMs } from '../src/lib/redis.js';

describe('Redis client', () => {
  test('uses capped exponential full jitter for reconnect attempts', () => {
    const maximumRandomValue = () => 1 - Number.EPSILON;

    expect(getRedisReconnectDelayMs(1, () => 0)).toBe(0);
    expect(getRedisReconnectDelayMs(1, maximumRandomValue)).toBe(100);
    expect(getRedisReconnectDelayMs(2, maximumRandomValue)).toBe(200);
    expect(getRedisReconnectDelayMs(6, maximumRandomValue)).toBe(3_200);
    expect(getRedisReconnectDelayMs(7, maximumRandomValue)).toBe(5_000);
    expect(getRedisReconnectDelayMs(1_000, maximumRandomValue)).toBe(5_000);
  });

  test('logs each outage and recovery once without warning on end', () => {
    const infoLogs: unknown[][] = [];
    const errorLogs: unknown[][] = [];
    const warningLogs: unknown[][] = [];
    const client = createRedisClient('redis://127.0.0.1:6379', {
      info: (...args: unknown[]) => infoLogs.push(args),
      error: (...args: unknown[]) => errorLogs.push(args),
      warn: (...args: unknown[]) => warningLogs.push(args),
    });
    const firstError = new Error('first connection failure');

    client.emit('error', firstError);
    client.emit('error', new Error('repeated connection failure'));
    client.emit('reconnecting', 100);
    client.emit('ready');

    expect(errorLogs).toEqual([[{ err: firstError }, 'Redis error']]);
    expect(warningLogs).toEqual([]);
    expect(infoLogs).toEqual([['Redis connection recovered']]);

    client.emit('reconnecting', 100);
    client.emit('reconnecting', 200);
    client.emit('ready');

    expect(errorLogs).toHaveLength(1);
    expect(warningLogs).toEqual([['Redis connection lost, reconnecting']]);
    expect(infoLogs).toEqual([['Redis connection recovered'], ['Redis connection recovered']]);

    client.emit('end');

    expect(warningLogs).toEqual([['Redis connection lost, reconnecting']]);
  });
});
