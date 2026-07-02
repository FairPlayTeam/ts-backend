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
  onAbort?: (reason: OperationTimeoutError) => void;
  run: () => Promise<T>;
};

export const observeOperation = async <T>({
  operation,
  timeoutMs,
  logger,
  data = {},
  successMessage,
  failureMessage,
  onAbort,
  run,
}: ObserveOperationOptions<T>): Promise<T> => {
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new OperationTimeoutError(operation, timeoutMs);
      reject(timeoutError);

      try {
        onAbort?.(timeoutError);
      } catch (abortError) {
        logger.warn(
          {
            err: abortError,
            ...data,
            operation,
            outcome: 'abort_cleanup_failure',
            durationMs: Date.now() - startedAt,
            timeoutMs,
          },
          'Operation abort cleanup failed',
        );
      }
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
