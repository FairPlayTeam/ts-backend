export type OperationLogger = {
  info: (data: object, message: string) => void;
  warn: (data: object, message: string) => void;
};

export class OperationTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export const noopOperationLogger: OperationLogger = {
  info: () => undefined,
  warn: () => undefined,
};

type ObserveOperationOptions<T> = {
  operation: string;
  timeoutMs: number;
  logger: OperationLogger;
  data?: Record<string, unknown>;
  successMessage: string;
  failureMessage: string;
  run: () => Promise<T>;
};

export const observeOperation = async <T>({
  operation,
  timeoutMs,
  logger,
  data = {},
  successMessage,
  failureMessage,
  run,
}: ObserveOperationOptions<T>): Promise<T> => {
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new OperationTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const result = await Promise.race([run(), timeoutPromise]);
    logger.info(
      {
        ...data,
        operation,
        outcome: 'success',
        durationMs: Date.now() - startedAt,
        timeoutMs,
      },
      successMessage,
    );

    return result;
  } catch (err) {
    logger.warn(
      {
        err,
        ...data,
        operation,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        timeoutMs,
      },
      failureMessage,
    );

    throw err;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};
