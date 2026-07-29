import { Prisma, type PrismaClient } from '@prisma/client';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

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

const isTransactionConflictError = (err: unknown): boolean =>
  (err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2034' || isRawPostgresSerializationFailure(err))) ||
  isDriverAdapterTransactionConflictError(err);

export const runSerializableTransaction = async <T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  for (let attempt = 1; attempt <= SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      if (!isTransactionConflictError(err) || attempt === SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS) {
        throw err;
      }
    }
  }

  throw new Error('Serializable transaction retry loop exhausted unexpectedly');
};
