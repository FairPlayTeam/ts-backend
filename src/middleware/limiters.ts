import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { HttpError } from '../errors/http.js';
import type { SendCommandFn } from 'rate-limit-redis';
import type { RedisClient } from '../lib/redis.js';
import type { Logger } from 'pino';

const AUTH_RATE_LIMIT_MESSAGE = 'Too many auth attempts, please try again after 10 minutes.';
const API_RATE_LIMIT_MESSAGE = 'Too many requests, please try again after 15 minutes.';

export const authRateLimitExceededHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(429, 'TooManyRequests', AUTH_RATE_LIMIT_MESSAGE));
};

export const apiRateLimitExceededHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(429, 'TooManyRequests', API_RATE_LIMIT_MESSAGE));
};

const makeStore = (prefix: string, redis: RedisClient | null) =>
  (() => {
    if (!redis) {
      return undefined;
    }

    return new RedisStore({
      sendCommand: ((...args: string[]) => {
        const [command, ...rest] = args;

        if (!command) {
          throw new Error('Redis command is empty');
        }

        return redis.call(command, ...rest);
      }) as SendCommandFn,
      prefix,
    });
  })();

export function createLimiters(deps: {
  redisClient: RedisClient | null;
  logger: Pick<Logger, 'warn'>;
}) {
  if (!deps.redisClient) {
    deps.logger.warn('REDIS_URL is not configured; rate limiting uses in-memory storage.');
  }

  const apiStore = makeStore('rl:api:', deps.redisClient);
  const authStore = makeStore('rl:auth:', deps.redisClient);

  return {
    apiLimiter: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 1200,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      passOnStoreError: true,
      ...(apiStore ? { store: apiStore } : {}),
      handler: apiRateLimitExceededHandler,
    }),
    authLimiter: rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      passOnStoreError: false,
      ...(authStore ? { store: authStore } : {}),
      handler: authRateLimitExceededHandler,
    }),
  };
}
