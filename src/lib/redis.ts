import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export type RedisClient = Pick<Redis, 'call' | 'disconnect' | 'quit' | 'ping'>;
type ConnectableRedisClient = Pick<Redis, 'connect' | 'status'>;

export const createRedisClient = (
  redisUrl: string,
  logger: Pick<Logger, 'info' | 'error' | 'warn'>,
): Redis => {
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
