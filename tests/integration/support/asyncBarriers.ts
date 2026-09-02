type BarrierWaitInput = {
  description: string;
  operations?: readonly Promise<unknown>[];
  signal: Promise<unknown>;
  timeoutMs?: number;
};

type LockInterleavingInput<TFirst, TSecond> = {
  firstBarrierDescription: string;
  firstOperation: Promise<TFirst>;
  firstPaused: Promise<unknown>;
  releaseFirst(): void;
  secondLockDescription: string;
  startSecond(): Promise<TSecond>;
  waitForSecondLock(signal: AbortSignal): Promise<void>;
};

type PausedOperationInput<TFirst, TWhilePaused> = {
  firstBarrierDescription: string;
  firstOperation: Promise<TFirst>;
  firstPaused: Promise<unknown>;
  releaseFirst(): void;
  runWhilePaused(): Promise<TWhilePaused>;
  whilePausedDescription: string;
};

type GatedOperationsController = {
  trackOperation<T>(operation: Promise<T>): Promise<T>;
  waitForSignal(input: {
    description: string;
    observe(signal: AbortSignal): Promise<void>;
    timeoutMs?: number;
  }): Promise<void>;
};

type GatedOperationResults<TOperations extends readonly Promise<unknown>[]> = {
  -readonly [Index in keyof TOperations]: Awaited<TOperations[Index]>;
};

type GatedOperationsInput<TOperations extends readonly Promise<unknown>[]> = {
  cleanup?: readonly (() => Promise<unknown>)[];
  gateBarrierDescription: string;
  gateOperation: Promise<unknown>;
  gatePaused: Promise<unknown>;
  releaseGate(): void;
  runWhileGateHeld(controller: GatedOperationsController): Promise<TOperations>;
};

const createBarrierTimeout = (description: string, timeoutMs: number) => {
  const outcome = Promise.withResolvers<void>();
  const settlement = outcome.promise.then(
    () => undefined,
    () => undefined,
  );
  const handle = setTimeout(() => {
    outcome.reject(new Error(`Timed out waiting for ${description}`));
  }, timeoutMs);

  return {
    cancel: (): Promise<void> => {
      clearTimeout(handle);
      outcome.resolve();

      return settlement;
    },
    promise: outcome.promise,
  };
};

export const throwCollectedErrors = (errors: readonly unknown[], message: string): void => {
  const uniqueErrors = [...new Set(errors)];

  if (uniqueErrors.length === 1) {
    throw uniqueErrors[0];
  }

  if (uniqueErrors.length > 1) {
    throw new AggregateError(uniqueErrors, message);
  }
};

export const waitForBarrier = async ({
  description,
  operations = [],
  signal,
  timeoutMs = 10_000,
}: BarrierWaitInput): Promise<void> => {
  const prematureOperations = operations.map((operation) =>
    operation.then<never>(
      () => {
        throw new Error(`An observed operation completed before ${description}`);
      },
      (error: unknown) => {
        throw error;
      },
    ),
  );
  const observedSignal = signal.then(() => undefined);
  const timeout = createBarrierTimeout(description, timeoutMs);

  try {
    await Promise.race([...prematureOperations, observedSignal, timeout.promise]);
  } finally {
    await timeout.cancel();
  }
};

export const coordinateGatedOperations = async <
  const TOperations extends readonly Promise<unknown>[],
>({
  cleanup = [],
  gateBarrierDescription,
  gateOperation,
  gatePaused,
  releaseGate,
  runWhileGateHeld,
}: GatedOperationsInput<TOperations>): Promise<GatedOperationResults<TOperations>> => {
  const operations: Promise<unknown>[] = [];
  const observationControllers: AbortController[] = [];
  const errors = new Set<unknown>();
  let returnedOperations: TOperations | null = null;

  try {
    await waitForBarrier({
      description: gateBarrierDescription,
      operations: [gateOperation],
      signal: gatePaused,
    });
    returnedOperations = await runWhileGateHeld({
      trackOperation: <T>(operation: Promise<T>): Promise<T> => {
        operations.push(operation);

        return operation;
      },
      waitForSignal: async ({ description, observe, timeoutMs }): Promise<void> => {
        const controller = new AbortController();
        observationControllers.push(controller);
        const observation = observe(controller.signal);
        await waitForBarrier({
          description,
          operations: [gateOperation, ...operations],
          signal: observation,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      },
    });
  } catch (error) {
    errors.add(error);
  } finally {
    for (const controller of observationControllers) {
      controller.abort();
    }

    try {
      releaseGate();
    } catch (error) {
      errors.add(error);
    }

    const operationResults = await Promise.allSettled([gateOperation, ...operations]);

    for (const result of operationResults) {
      if (result.status === 'rejected') {
        errors.add(result.reason);
      }
    }

    const cleanupResults = await Promise.allSettled(cleanup.map(async (run) => run()));

    for (const result of cleanupResults) {
      if (result.status === 'rejected') {
        errors.add(result.reason);
      }
    }
  }

  throwCollectedErrors([...errors], 'Gated-operation coordination failed');

  if (!returnedOperations) {
    throw new Error('Gated-operation coordination did not return its operations');
  }

  return Promise.all(returnedOperations);
};

export const coordinateLockInterleavingSettled = async <TFirst, TSecond>({
  firstBarrierDescription,
  firstOperation,
  firstPaused,
  releaseFirst,
  secondLockDescription,
  startSecond,
  waitForSecondLock,
}: LockInterleavingInput<TFirst, TSecond>): Promise<
  [PromiseSettledResult<TFirst>, PromiseSettledResult<TSecond>]
> => {
  let lockObservationController: AbortController | null = null;
  let secondOperation: Promise<TSecond> | null = null;
  let operationResults:
    [PromiseSettledResult<TFirst>] | [PromiseSettledResult<TFirst>, PromiseSettledResult<TSecond>];
  const coordinationErrors = new Set<unknown>();

  try {
    await waitForBarrier({
      description: firstBarrierDescription,
      operations: [firstOperation],
      signal: firstPaused,
    });
    secondOperation = startSecond();
    lockObservationController = new AbortController();
    const lockObservation = waitForSecondLock(lockObservationController.signal);
    await waitForBarrier({
      description: secondLockDescription,
      operations: [firstOperation, secondOperation],
      signal: lockObservation,
    });
  } catch (error) {
    coordinationErrors.add(error);
  } finally {
    lockObservationController?.abort();

    try {
      releaseFirst();
    } catch (error) {
      coordinationErrors.add(error);
    }

    operationResults = secondOperation
      ? await Promise.allSettled([firstOperation, secondOperation])
      : await Promise.allSettled([firstOperation]);
  }

  if (coordinationErrors.size > 0) {
    for (const result of operationResults) {
      if (result.status === 'rejected') {
        coordinationErrors.add(result.reason);
      }
    }
  }

  throwCollectedErrors([...coordinationErrors], 'Lock interleaving coordination failed');

  const [firstResult, secondResult] = operationResults;

  if (!secondResult) {
    throw new Error('The second lock-interleaving operation did not start');
  }

  return [firstResult, secondResult];
};

export const coordinateLockInterleaving = async <TFirst, TSecond>(
  input: LockInterleavingInput<TFirst, TSecond>,
): Promise<[TFirst, TSecond]> => {
  const [firstResult, secondResult] = await coordinateLockInterleavingSettled(input);
  const operationErrors = [firstResult, secondResult].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );

  throwCollectedErrors(operationErrors, 'Lock interleaving operations failed');

  if (firstResult.status !== 'fulfilled' || secondResult.status !== 'fulfilled') {
    throw new Error('Lock interleaving operations did not both fulfill');
  }

  return [firstResult.value, secondResult.value];
};

export const coordinateWhilePaused = async <TFirst, TWhilePaused>({
  firstBarrierDescription,
  firstOperation,
  firstPaused,
  releaseFirst,
  runWhilePaused,
  whilePausedDescription,
}: PausedOperationInput<TFirst, TWhilePaused>): Promise<[TFirst, TWhilePaused]> => {
  let whilePausedOperation: Promise<TWhilePaused> | null = null;
  let operationResults:
    | [PromiseSettledResult<TFirst>]
    | [PromiseSettledResult<TFirst>, PromiseSettledResult<TWhilePaused>];
  const errors = new Set<unknown>();

  try {
    await waitForBarrier({
      description: firstBarrierDescription,
      operations: [firstOperation],
      signal: firstPaused,
    });
    whilePausedOperation = runWhilePaused();
    await waitForBarrier({
      description: whilePausedDescription,
      operations: [firstOperation],
      signal: whilePausedOperation.then(() => undefined),
    });
  } catch (error) {
    errors.add(error);
  } finally {
    try {
      releaseFirst();
    } catch (error) {
      errors.add(error);
    }

    operationResults = whilePausedOperation
      ? await Promise.allSettled([firstOperation, whilePausedOperation])
      : await Promise.allSettled([firstOperation]);
  }

  const [firstResult, whilePausedResult] = operationResults;

  if (firstResult.status === 'rejected') {
    errors.add(firstResult.reason);
  }
  if (whilePausedResult?.status === 'rejected') {
    errors.add(whilePausedResult.reason);
  }

  throwCollectedErrors([...errors], 'Paused-operation coordination failed');

  if (firstResult.status !== 'fulfilled' || whilePausedResult?.status !== 'fulfilled') {
    throw new Error('Paused-operation coordination did not complete both operations');
  }

  return [firstResult.value, whilePausedResult.value];
};
