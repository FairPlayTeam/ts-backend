import { Redis } from 'ioredis';
import config from '../config/env.js';
import { logger } from './logger.js';

type RedisClient = Pick<Redis, 'call' | 'disconnect' | 'quit'>;

let redisClient: Redis | null = null;

const createRedisClient = (redisUrl: string): Redis => {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });

  client.on('error', (err) => {
    logger.error({ err }, 'Redis error');
  });

  client.on('end', () => {
    logger.warn('Redis connection closed');
  });

  return client;
};

export const isRedisConfigured = (): boolean => config.redisUrl !== null;

export const getRedisClient = (): RedisClient | null => {
  if (!config.redisUrl) {
    return null;
  }

  redisClient ??= createRedisClient(config.redisUrl);
  return redisClient;
};

export const closeRedisClient = async (): Promise<void> => {
  if (!redisClient) {
    return;
  }

  const client = redisClient;
  redisClient = null;

  try {
    await client.quit();
  } catch (err) {
    logger.warn({ err }, 'Redis quit failed, forcing disconnect');
    client.disconnect();
  }
};
