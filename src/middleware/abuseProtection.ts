import crypto from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';
import type { RedisClient } from '../lib/redis.js';

type JsonObject = Record<string, unknown>;

type EmailCooldownOptions = {
  redisClient: RedisClient | null;
  keyPrefix: string;
  keySecret: string;
  ttlMs: number;
  acceptedResponse: JsonObject;
  getIdentifier(this: void, req: Request): string | null;
  logger: Pick<Logger, 'warn'>;
};

export const hashRateLimitIdentifier = (secret: string, identifier: string): string =>
  crypto.createHmac('sha256', secret).update(identifier.trim().toLowerCase()).digest('hex');

const ACTIVE_COOLDOWN_VALUE = 'active';
const RELEASE_PENDING_COOLDOWN_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end

return 0
`;

const isRedisSetSuccess = (result: unknown): boolean => result === 'OK';
const isSuccessfulResponse = (statusCode: number): boolean => statusCode >= 200 && statusCode < 400;

const releasePendingCooldown = (
  redisClient: RedisClient,
  key: string,
  pendingToken: string,
  logger: Pick<Logger, 'warn'>,
): void => {
  void redisClient
    .call('eval', RELEASE_PENDING_COOLDOWN_SCRIPT, '1', key, pendingToken)
    .catch((err: unknown) => {
      logger.warn({ err }, 'Email cooldown pending lock release failed');
    });
};

export const createEmailCooldown = ({
  redisClient,
  keyPrefix,
  keySecret,
  ttlMs,
  acceptedResponse,
  getIdentifier,
  logger,
}: EmailCooldownOptions): RequestHandler => {
  return async (req, res, next): Promise<void> => {
    const identifier = getIdentifier(req);

    if (!identifier || !redisClient) {
      next();
      return;
    }

    const key = `${keyPrefix}:${hashRateLimitIdentifier(keySecret, identifier)}`;
    const pendingToken = `pending:${crypto.randomUUID()}`;

    try {
      const result = await redisClient.call('set', key, pendingToken, 'PX', String(ttlMs), 'NX');

      if (!isRedisSetSuccess(result)) {
        res.status(200).json(acceptedResponse);
        return;
      }
    } catch (err) {
      logger.warn({ err }, 'Email cooldown store unavailable, allowing request');
      next();
      return;
    }

    res.once('finish', () => {
      if (!isSuccessfulResponse(res.statusCode)) {
        releasePendingCooldown(redisClient, key, pendingToken, logger);
        return;
      }

      void redisClient
        .call('set', key, ACTIVE_COOLDOWN_VALUE, 'PX', String(ttlMs))
        .catch((err: unknown) => {
          logger.warn({ err }, 'Email cooldown store unavailable after successful response');
        });
    });

    next();
  };
};
