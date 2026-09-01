import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import {
  coordinateGatedOperations,
  coordinateLockInterleaving,
  coordinateLockInterleavingSettled,
  coordinateWhilePaused,
  throwCollectedErrors,
  waitForBarrier,
} from './integration/support/asyncBarriers.js';

const never = new Promise<void>(() => undefined);

test('barrier settles its cancelled timeout before resolving from its signal', async () => {
  const outcome = await Promise.race([
    waitForBarrier({
      description: 'the test signal',
      signal: Promise.resolve(),
    }).then(() => 'settled' as const),
    delay(100).then(() => 'still pending' as const),
  ]);

  expect(outcome).toBe('settled');
});

test('barrier fails immediately when an observed operation rejects first', async () => {
  const operationError = new Error('operation failed');

  await expect(
    waitForBarrier({
      description: 'an unreachable signal',
      operations: [Promise.reject(operationError)],
      signal: never,
      timeoutMs: 1_000,
    }),
  ).rejects.toBe(operationError);
});

test('barrier preserves an already-settled operation failure when its signal is also settled', async () => {
  const operationError = new Error('operation failed before the barrier attached');

  await expect(
    waitForBarrier({
      description: 'an already-settled signal',
      operations: [Promise.reject(operationError)],
      signal: Promise.resolve(),
    }),
  ).rejects.toBe(operationError);
});

test('barrier rejects when an observed operation completes before its signal', async () => {
  await expect(
    waitForBarrier({
      description: 'an unreachable signal',
      operations: [Promise.resolve()],
      signal: never,
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow('An observed operation completed before an unreachable signal');
});

test('barrier has a bounded wait when neither signal nor operation settles', async () => {
  await expect(
    waitForBarrier({
      description: 'an unreachable signal',
      signal: never,
      timeoutMs: 10,
    }),
  ).rejects.toThrow('Timed out waiting for an unreachable signal');
});

test('lock coordination releases and settles both operations when lock observation fails', async () => {
  const firstPaused = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const lockError = new Error('lock observation failed');
  let firstCompleted = false;
  let secondCompleted = false;
  const firstOperation = (async () => {
    firstPaused.resolve();
    await releaseFirst.promise;
    firstCompleted = true;

    return 'first';
  })();

  await expect(
    coordinateLockInterleaving({
      firstBarrierDescription: 'the first test operation',
      firstOperation,
      firstPaused: firstPaused.promise,
      releaseFirst: releaseFirst.resolve,
      secondLockDescription: 'the second test lock',
      startSecond: async () => {
        await releaseFirst.promise;
        secondCompleted = true;

        return 'second';
      },
      waitForSecondLock: async () => {
        throw lockError;
      },
    }),
  ).rejects.toBe(lockError);
  expect(firstCompleted).toBe(true);
  expect(secondCompleted).toBe(true);
});

test('gated coordination releases and cleans up when the gate fails before its barrier', async () => {
  const gateError = new Error('gate transaction failed');
  let released = false;
  let cleanedUp = false;
  let operationsStarted = false;

  await expect(
    coordinateGatedOperations({
      cleanup: [
        async () => {
          cleanedUp = true;
        },
      ],
      gateBarrierDescription: 'an unreachable test gate',
      gateOperation: Promise.reject(gateError),
      gatePaused: never,
      releaseGate: () => {
        released = true;
      },
      runWhileGateHeld: async () => {
        operationsStarted = true;

        return [];
      },
    }),
  ).rejects.toBe(gateError);
  expect(released).toBe(true);
  expect(cleanedUp).toBe(true);
  expect(operationsStarted).toBe(false);
});

test('gated coordination settles operations and cleanup before reporting every failure', async () => {
  const gatePaused = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();
  const observationError = new Error('gate observation failed');
  const operationError = new Error('gated operation failed after release');
  const gateOperation = (async () => {
    gatePaused.resolve();
    await releaseGate.promise;
  })();
  let operationCompleted = false;
  let cleanedUp = false;

  await expect(
    coordinateGatedOperations({
      cleanup: [
        async () => {
          cleanedUp = true;
        },
      ],
      gateBarrierDescription: 'the acquired test gate',
      gateOperation,
      gatePaused: gatePaused.promise,
      releaseGate: releaseGate.resolve,
      runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
        const operation = trackOperation(
          (async () => {
            await releaseGate.promise;
            operationCompleted = true;
            throw operationError;
          })(),
        );
        await waitForSignal({
          description: 'the failing gated observation',
          observe: async () => {
            throw observationError;
          },
        });

        return [operation] as const;
      },
    }),
  ).rejects.toMatchObject({
    errors: [observationError, operationError],
    message: 'Gated-operation coordination failed',
  });
  expect(operationCompleted).toBe(true);
  expect(cleanedUp).toBe(true);
});

test('gated coordination remains bounded when an observer ignores cancellation', async () => {
  const gatePaused = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();
  const gateOperation = (async () => {
    gatePaused.resolve();
    await releaseGate.promise;
  })();
  const coordination = coordinateGatedOperations({
    gateBarrierDescription: 'the non-cancellable-observer test gate',
    gateOperation,
    gatePaused: gatePaused.promise,
    releaseGate: releaseGate.resolve,
    runWhileGateHeld: async ({ waitForSignal }) => {
      await waitForSignal({
        description: 'the non-cancellable test observer',
        observe: () => never,
        timeoutMs: 10,
      });

      return [];
    },
  });
  const outcome = await Promise.race([
    coordination.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    delay(100).then(() => 'pending' as const),
  ]);

  expect(outcome).toBe('rejected');
  await expect(coordination).rejects.toThrow(
    'Timed out waiting for the non-cancellable test observer',
  );
});

test('settled lock coordination preserves an expected rejection after the lock is observed', async () => {
  const firstPaused = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const expectedSecondError = new Error('serialized operation rejected');
  const firstOperation = (async () => {
    firstPaused.resolve();
    await releaseFirst.promise;

    return 'first';
  })();
  const results = await coordinateLockInterleavingSettled({
    firstBarrierDescription: 'the first settled test operation',
    firstOperation,
    firstPaused: firstPaused.promise,
    releaseFirst: releaseFirst.resolve,
    secondLockDescription: 'the observed settled test lock',
    startSecond: async () => {
      await releaseFirst.promise;
      throw expectedSecondError;
    },
    waitForSecondLock: () => Promise.resolve(),
  });

  expect(results).toEqual([
    { status: 'fulfilled', value: 'first' },
    { status: 'rejected', reason: expectedSecondError },
  ]);
});

test('lock coordination releases the first operation when it fails before its barrier', async () => {
  const operationError = new Error('first operation failed');
  let released = false;
  let secondStarted = false;

  await expect(
    coordinateLockInterleaving({
      firstBarrierDescription: 'an unreachable first-operation barrier',
      firstOperation: Promise.reject(operationError),
      firstPaused: never,
      releaseFirst: () => {
        released = true;
      },
      secondLockDescription: 'an unreachable second-operation lock',
      startSecond: async () => {
        secondStarted = true;
      },
      waitForSecondLock: () => never,
    }),
  ).rejects.toBe(operationError);
  expect(released).toBe(true);
  expect(secondStarted).toBe(false);
});

test('lock coordination cancels its lock observer after a premature operation failure', async () => {
  const firstPaused = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const operationError = new Error('second operation failed before the lock');
  let observerCancelled = false;
  const firstOperation = (async () => {
    firstPaused.resolve();
    await releaseFirst.promise;
  })();
  const coordination = coordinateLockInterleaving({
    firstBarrierDescription: 'the first observer-settlement operation',
    firstOperation,
    firstPaused: firstPaused.promise,
    releaseFirst: releaseFirst.resolve,
    secondLockDescription: 'an unsettled test lock observer',
    startSecond: () => Promise.reject(operationError),
    waitForSecondLock: (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            observerCancelled = true;
            resolve();
          },
          { once: true },
        );
      }),
  });
  const outcome = await Promise.race([
    coordination.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    delay(100).then(() => 'pending' as const),
  ]);

  expect(outcome).toBe('rejected');
  await expect(coordination).rejects.toBe(operationError);
  expect(observerCancelled).toBe(true);
});

test('lock coordination reports operation failures that occur while recovering from an observer failure', async () => {
  const firstPaused = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const lockError = new Error('lock observation failed');
  const firstError = new Error('first operation failed after release');
  const secondError = new Error('second operation failed after release');
  const firstOperation = (async () => {
    firstPaused.resolve();
    await releaseFirst.promise;
    throw firstError;
  })();

  await expect(
    coordinateLockInterleaving({
      firstBarrierDescription: 'the first aggregate-error operation',
      firstOperation,
      firstPaused: firstPaused.promise,
      releaseFirst: releaseFirst.resolve,
      secondLockDescription: 'the failing aggregate-error lock observer',
      startSecond: async () => {
        await releaseFirst.promise;
        throw secondError;
      },
      waitForSecondLock: async () => {
        throw lockError;
      },
    }),
  ).rejects.toMatchObject({
    errors: [lockError, firstError, secondError],
    message: 'Lock interleaving coordination failed',
  });
});

test('paused-operation coordination releases and settles its first operation after an inner failure', async () => {
  const firstPaused = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const innerError = new Error('operation during pause failed');
  let firstCompleted = false;
  const firstOperation = (async () => {
    firstPaused.resolve();
    await releaseFirst.promise;
    firstCompleted = true;

    return 'first';
  })();

  await expect(
    coordinateWhilePaused({
      firstBarrierDescription: 'the paused test operation',
      firstOperation,
      firstPaused: firstPaused.promise,
      releaseFirst: releaseFirst.resolve,
      runWhilePaused: async () => {
        throw innerError;
      },
      whilePausedDescription: 'the failing inner test operation',
    }),
  ).rejects.toBe(innerError);
  expect(firstCompleted).toBe(true);
});

test('collected-error reporting preserves a single original failure', () => {
  const originalError = new Error('original failure');

  expect(() => throwCollectedErrors([originalError], 'cleanup failed')).toThrow(originalError);
});

test('collected-error reporting collapses duplicate references to the original failure', () => {
  const originalError = new Error('duplicated failure');

  expect(() => throwCollectedErrors([originalError, originalError], 'cleanup failed')).toThrow(
    originalError,
  );
});

test('collected-error reporting retains every concurrent cleanup failure', () => {
  const firstError = new Error('first failure');
  const secondError = new Error('second failure');

  expect(() => throwCollectedErrors([firstError, secondError], 'cleanup failed')).toThrow(
    expect.objectContaining({
      errors: [firstError, secondError],
      message: 'cleanup failed',
    }),
  );
});
