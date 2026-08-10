import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { USER_ACCOUNT_OPERATION_LOCK_TTL_MS } from '../config/constants.js';
import { HttpError } from '../errors/http.js';
import type { RedisClient } from '../lib/redis.js';
import { createRedisLeaseManager, type RedisLease } from '../lib/redisLease.js';
import type { AuthenticatedRequest } from './auth.js';
import { hashRateLimitIdentifier } from './abuseProtection.js';

export const USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE =
  'A personal data export or account deletion is already in progress';
export const USER_ACCOUNT_OPERATION_LOCK_UNAVAILABLE_MESSAGE =
  'Personal account operation coordination is temporarily unavailable';

type UserAccountOperationGuardLogger = {
  error(data: object, message: string): void;
  warn(data: object, message: string): void;
};

export type UserAccountOperationGuard = (handler: RequestHandler) => RequestHandler;

export const createUserAccountOperationGuard = ({
  redisClient,
  keySecret,
  logger,
  ttlMs = USER_ACCOUNT_OPERATION_LOCK_TTL_MS,
}: {
  redisClient: Pick<RedisClient, 'call'> | null;
  keySecret: string;
  logger: UserAccountOperationGuardLogger;
  ttlMs?: number;
}): UserAccountOperationGuard => {
  const activeUserIds = new Set<string>();
  const leaseManager = redisClient ? createRedisLeaseManager({ redisClient, ttlMs }) : null;

  return (handler) => async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as AuthenticatedRequest).user.id;

    if (activeUserIds.has(userId)) {
      next(new HttpError(409, 'Conflict', USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE));
      return;
    }

    activeUserIds.add(userId);
    let cleanupStarted = false;
    let lease: RedisLease | null = null;
    let leaseReleased = false;
    let renewing = false;
    let renewalTimer: ReturnType<typeof setInterval> | null = null;
    let responseClosed = res.destroyed;

    const releaseLease = async (): Promise<void> => {
      if (!lease || leaseReleased) {
        return;
      }

      leaseReleased = true;
      await lease.release().catch((err: unknown) => {
        logger.warn({ err, userId }, 'Personal account operation lock release failed');
      });
    };

    const cleanup = async (): Promise<void> => {
      if (!cleanupStarted) {
        cleanupStarted = true;
        activeUserIds.delete(userId);

        if (renewalTimer) {
          clearInterval(renewalTimer);
          renewalTimer = null;
        }
      }

      await releaseLease();
    };

    const onEarlyClose = (): void => {
      responseClosed = true;
    };

    // Observe disconnects before the potentially asynchronous Redis acquisition. A close event is
    // not replayed for listeners registered later, so registering after await would leak the lease.
    res.once('close', onEarlyClose);
    res.once('finish', onEarlyClose);

    if (responseClosed) {
      await cleanup();
      return;
    }

    try {
      if (leaseManager) {
        const lockKey = `lock:auth:account-operation:${hashRateLimitIdentifier(keySecret, userId)}`;
        lease = await leaseManager.acquire(lockKey);

        if (responseClosed || cleanupStarted) {
          await cleanup();
          return;
        }

        if (!lease) {
          await cleanup();
          next(new HttpError(409, 'Conflict', USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE));
          return;
        }
      }
    } catch (err) {
      await cleanup();

      if (responseClosed) {
        return;
      }

      logger.error({ err, userId }, 'Personal account operation lock acquisition failed');
      next(
        new HttpError(503, 'ServiceUnavailable', USER_ACCOUNT_OPERATION_LOCK_UNAVAILABLE_MESSAGE, {
          cause: err,
        }),
      );
      return;
    }

    const loseLease = (err?: unknown): void => {
      logger.error(
        { ...(err === undefined ? {} : { err }), userId },
        'Personal account operation lock ownership lost',
      );

      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }

      if (!res.destroyed) {
        res.destroy();
      }
    };

    if (lease) {
      const acquiredLease = lease;
      renewalTimer = setInterval(() => {
        if (renewing || cleanupStarted) {
          return;
        }

        renewing = true;
        void acquiredLease
          .renew()
          .then((owned) => {
            if (!owned && !cleanupStarted) {
              loseLease();
            }
          })
          .catch((err: unknown) => {
            if (!cleanupStarted) {
              loseLease(err);
            }
          })
          .finally(() => {
            renewing = false;
          });
      }, acquiredLease.renewalIntervalMs);
      renewalTimer.unref?.();
    }

    res.off('close', onEarlyClose);
    res.off('finish', onEarlyClose);

    try {
      await handler(req, res, next);
    } finally {
      await cleanup();
    }
  };
};
