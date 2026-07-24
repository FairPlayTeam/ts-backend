import { Prisma, type PrismaClient } from '@prisma/client';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

const isTransactionConflictError = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

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
