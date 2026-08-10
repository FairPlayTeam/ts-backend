import { Prisma, type PrismaClient } from '@prisma/client';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;
const SERIALIZABLE_TRANSACTION_RETRY_BASE_DELAY_MS = 5;
const SERIALIZABLE_TRANSACTION_RETRY_MAX_DELAY_MS = 250;

type SerializableTransactionOptions = {
  maxAttempts?: number;
  retryDelayMs?: number | ((attempt: number) => number);
};

const isDriverAdapterTransactionConflictError = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) {
    return false;
  }

  const driverError = err as {
    cause?: {
      kind?: unknown;
    };
    name?: unknown;
  };

  return (
    driverError.name === 'DriverAdapterError' &&
    driverError.cause?.kind === 'TransactionWriteConflict'
  );
};

const isRawPostgresSerializationFailure = (err: Prisma.PrismaClientKnownRequestError): boolean => {
  if (err.code !== 'P2010') {
    return false;
  }

  const driverAdapterError = err.meta?.['driverAdapterError'];

  if (typeof driverAdapterError !== 'object' || driverAdapterError === null) {
    return false;
  }

  const cause = (driverAdapterError as { cause?: unknown }).cause;

  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { originalCode?: unknown }).originalCode === '40001'
  );
};

export const isSerializableTransactionConflictError = (err: unknown): boolean =>
  (err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2034' || isRawPostgresSerializationFailure(err))) ||
  isDriverAdapterTransactionConflictError(err);

export const getSerializableTransactionRetryDelayMs = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const exponent = Math.max(0, attempt - 1);
  const delayCeiling = Math.min(
    SERIALIZABLE_TRANSACTION_RETRY_MAX_DELAY_MS,
    SERIALIZABLE_TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** exponent,
  );

  return Math.floor(random() * (delayCeiling + 1));
};

export const runSerializableTransaction = async <T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableTransactionOptions = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      if (!isSerializableTransactionConflictError(err) || attempt === maxAttempts) {
        throw err;
      }

      const retryDelayMs =
        typeof options.retryDelayMs === 'function'
          ? options.retryDelayMs(attempt)
          : (options.retryDelayMs ?? 0);

      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw new Error('Serializable transaction retry loop exhausted unexpectedly');
};
