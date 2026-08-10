import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../src/errors/http.js';
import type { AuthenticatedRequest } from '../src/middleware/auth.js';
import {
  createUserAccountOperationGuard,
  USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
  type UserAccountOperationGuard,
} from '../src/middleware/userAccountOperationGuard.js';

const createResponse = () => {
  const emitter = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    destroy(): void;
  };
  emitter.destroyed = false;
  emitter.destroy = () => {
    emitter.destroyed = true;
    emitter.emit('close');
  };

  return emitter as unknown as Response;
};

const createRequest = (userId: string) =>
  ({ user: { id: userId } }) as unknown as AuthenticatedRequest;

const invokeGuard = async (
  guard: UserAccountOperationGuard,
  req: Request,
  res: Response,
  handler: RequestHandler = () => undefined,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let nextCalled = false;
    let nextError: unknown;
    const guardedHandler = guard(handler);

    Promise.resolve(
      guardedHandler(req, res, ((err?: unknown) => {
        nextCalled = true;
        nextError = err;
      }) as NextFunction),
    )
      .then(() => resolve(nextCalled ? nextError : undefined))
      .catch(reject);
  });

describe('personal account operation concurrency guard', () => {
  test('rejects a concurrent account operation until the first handler promise resolves', async () => {
    const guard = createUserAccountOperationGuard({
      redisClient: null,
      keySecret: 'test-rate-limit-key-secret-123456',
      logger: { error: () => undefined, warn: () => undefined },
    });
    const firstResponse = createResponse();
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    const firstExecution = invokeGuard(guard, createRequest('user-id'), firstResponse, async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
    });

    await operationStarted.promise;

    const conflict = await invokeGuard(guard, createRequest('user-id'), createResponse());
    expect(conflict).toBeInstanceOf(HttpError);
    expect(conflict).toMatchObject({
      statusCode: 409,
      code: 'Conflict',
      message: USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
    });

    firstResponse.destroy();
    const conflictAfterDisconnect = await invokeGuard(
      guard,
      createRequest('user-id'),
      createResponse(),
    );
    expect(conflictAfterDisconnect).toMatchObject({
      statusCode: 409,
      message: USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
    });

    releaseOperation.resolve();
    await expect(firstExecution).resolves.toBeUndefined();

    await expect(
      invokeGuard(guard, createRequest('user-id'), createResponse()),
    ).resolves.toBeUndefined();
  });

  test('releases a Redis lease acquired after the response closed and accepts the next operation', async () => {
    const setStarted = Promise.withResolvers<void>();
    const releaseSet = Promise.withResolvers<void>();
    const locks = new Map<string, string>();
    let releaseCalls = 0;
    const redisClient = {
      call: async (command: string, ...args: unknown[]) => {
        if (command === 'set') {
          const [key, token] = args as [string, string];
          setStarted.resolve();
          await releaseSet.promise;

          if (locks.has(key)) {
            return null;
          }

          locks.set(key, token);
          return 'OK';
        }

        if (command === 'eval') {
          const [script, _keyCount, key, token] = args as [string, string, string, string];

          if (script.includes('del') && locks.get(key) === token) {
            releaseCalls += 1;
            locks.delete(key);
            return 1;
          }

          return locks.get(key) === token ? 1 : 0;
        }

        throw new Error(`Unexpected Redis command: ${command}`);
      },
    };
    const guard = createUserAccountOperationGuard({
      redisClient,
      keySecret: 'test-rate-limit-key-secret-123456',
      logger: { error: () => undefined, warn: () => undefined },
      ttlMs: 60_000,
    });
    const interruptedResponse = createResponse();
    let firstNextCalls = 0;
    const firstExecution = guard(() => {
      firstNextCalls += 1;
    })(
      createRequest('interrupted-user-id'),
      interruptedResponse,
      (() => undefined) as NextFunction,
    );

    await setStarted.promise;
    interruptedResponse.destroy();
    releaseSet.resolve();
    await Promise.resolve(firstExecution);

    expect(firstNextCalls).toBe(0);
    expect(releaseCalls).toBe(1);
    const nextResponse = createResponse();
    await expect(
      invokeGuard(guard, createRequest('interrupted-user-id'), nextResponse),
    ).resolves.toBeUndefined();
    nextResponse.emit('finish');
  });

  test('keeps the shared Redis lease across disconnect until the handler settles', async () => {
    const locks = new Map<string, string>();
    let releaseCalls = 0;
    let releaseObserved: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseObserved = resolve;
    });
    const redisClient = {
      call: async (command: string, ...args: unknown[]) => {
        if (command === 'set') {
          const [key, token] = args as [string, string];

          if (locks.has(key)) {
            return null;
          }

          locks.set(key, token);
          return 'OK';
        }

        if (command === 'eval') {
          const [script, _keyCount, key, token] = args as [string, string, string, string];

          if (script.includes('del') && locks.get(key) === token) {
            releaseCalls += 1;
            locks.delete(key);
            releaseObserved?.();
            return 1;
          }

          return locks.get(key) === token ? 1 : 0;
        }

        throw new Error(`Unexpected Redis command: ${command}`);
      },
    };
    const dependencies = {
      redisClient,
      keySecret: 'test-rate-limit-key-secret-123456',
      logger: { error: () => undefined, warn: () => undefined },
      ttlMs: 60_000,
    };
    const firstGuard = createUserAccountOperationGuard(dependencies);
    const secondGuard = createUserAccountOperationGuard(dependencies);
    const firstResponse = createResponse();
    const releaseOperation = Promise.withResolvers<void>();
    const operationStarted = Promise.withResolvers<void>();
    const firstExecution = invokeGuard(
      firstGuard,
      createRequest('shared-user-id'),
      firstResponse,
      async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
      },
    );

    await operationStarted.promise;
    firstResponse.destroy();

    const conflict = await invokeGuard(
      secondGuard,
      createRequest('shared-user-id'),
      createResponse(),
    );
    expect(conflict).toMatchObject({
      statusCode: 409,
      message: USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
    });
    expect(releaseCalls).toBe(0);

    releaseOperation.resolve();
    await firstExecution;
    await released;
    expect(releaseCalls).toBe(1);

    await expect(
      invokeGuard(secondGuard, createRequest('shared-user-id'), createResponse()),
    ).resolves.toBeUndefined();
  });
});
