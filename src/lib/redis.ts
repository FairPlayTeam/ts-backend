import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { getCappedExponentialFullJitterDelayMs } from './retryBackoff.js';

export type RedisClient = Pick<Redis, 'call' | 'disconnect' | 'quit' | 'ping'>;
type ConnectableRedisClient = Pick<Redis, 'connect' | 'status'>;

const REDIS_RECONNECT_BASE_DELAY_MS = 100;
const REDIS_RECONNECT_MAX_DELAY_MS = 5_000;

export const getRedisReconnectDelayMs = (
  attempt: number,
  random: () => number = Math.random,
): number =>
  getCappedExponentialFullJitterDelayMs(
    attempt,
    REDIS_RECONNECT_BASE_DELAY_MS,
    REDIS_RECONNECT_MAX_DELAY_MS,
    random,
  );

export const createRedisClient = (
  redisUrl: string,
  logger: Pick<Logger, 'info' | 'error' | 'warn'>,
): Redis => {
  let isUnavailable = false;
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: getRedisReconnectDelayMs,
  });

  client.on('ready', () => {
    logger.info(isUnavailable ? 'Redis connection recovered' : 'Redis ready');
    isUnavailable = false;
  });

  client.on('error', (err) => {
    if (isUnavailable) {
      return;
    }

    isUnavailable = true;
    logger.error({ err }, 'Redis error');
  });

  client.on('reconnecting', () => {
    if (isUnavailable) {
      return;
    }

    isUnavailable = true;
    logger.warn('Redis connection lost, reconnecting');
  });

  return client;
};

export const closeRedisClient = async (
  redisClient: RedisClient | null,
  logger: Pick<Logger, 'warn'>,
): Promise<void> => {
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.quit();
  } catch (err) {
    logger.warn({ err }, 'Redis quit failed, forcing disconnect');
    redisClient.disconnect();
  }
};

export const connectRedisClient = async (client: ConnectableRedisClient): Promise<void> => {
  if (client.status === 'ready' || client.status === 'connect' || client.status === 'connecting') {
    return;
  }

  await client.connect();
};
