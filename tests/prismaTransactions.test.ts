import { describe, expect, test } from 'bun:test';
import { Prisma, type PrismaClient } from '@prisma/client';

import {
  getSerializableTransactionRetryDelayMs,
  runSerializableTransaction,
} from '../src/lib/prismaTransactions.js';

describe('Prisma transactions', () => {
  test('provides capped exponential full jitter for contention retries', () => {
    expect(getSerializableTransactionRetryDelayMs(1, () => 0)).toBe(0);
    expect(getSerializableTransactionRetryDelayMs(1, () => 0.999)).toBe(5);
    expect(getSerializableTransactionRetryDelayMs(2, () => 0.999)).toBe(10);
    expect(getSerializableTransactionRetryDelayMs(6, () => 0.999)).toBe(160);
    expect(getSerializableTransactionRetryDelayMs(7, () => 0.999)).toBe(250);
    expect(getSerializableTransactionRetryDelayMs(20, () => 0.999)).toBe(250);
  });

  test('retries transaction conflicts surfaced directly by the driver adapter', async () => {
    let attempts = 0;
    const conflict = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: {
        kind: 'TransactionWriteConflict',
      },
    });
    const prisma = {
      $transaction: async (callback: (tx: never) => Promise<string>) => {
        attempts += 1;

        if (attempts < 3) {
          throw conflict;
        }

        return callback({} as never);
      },
    } as unknown as Pick<PrismaClient, '$transaction'>;

    await expect(runSerializableTransaction(prisma, async () => 'committed')).resolves.toBe(
      'committed',
    );
    expect(attempts).toBe(3);
  });

  test('retries PostgreSQL serialization failures wrapped as raw query errors', async () => {
    let attempts = 0;
    const conflict = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed with PostgreSQL serialization error',
      {
        clientVersion: 'test',
        code: 'P2010',
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: '40001',
            },
          },
        },
      },
    );
    const prisma = {
      $transaction: async (callback: (tx: never) => Promise<string>) => {
        attempts += 1;

        if (attempts === 1) {
          throw conflict;
        }

        return callback({} as never);
      },
    } as unknown as Pick<PrismaClient, '$transaction'>;

    await expect(runSerializableTransaction(prisma, async () => 'committed')).resolves.toBe(
      'committed',
    );
    expect(attempts).toBe(2);
  });

  test('keeps the three-attempt default while allowing a caller-specific retry budget', async () => {
    let defaultAttempts = 0;
    let configuredAttempts = 0;
    const delayedAttempts: number[] = [];
    const conflict = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: {
        kind: 'TransactionWriteConflict',
      },
    });
    const defaultPrisma = {
      $transaction: async () => {
        defaultAttempts += 1;
        throw conflict;
      },
    } as unknown as Pick<PrismaClient, '$transaction'>;
    const configuredPrisma = {
      $transaction: async (callback: (tx: never) => Promise<string>) => {
        configuredAttempts += 1;

        if (configuredAttempts < 5) {
          throw conflict;
        }

        return callback({} as never);
      },
    } as unknown as Pick<PrismaClient, '$transaction'>;

    await expect(runSerializableTransaction(defaultPrisma, async () => 'unreachable')).rejects.toBe(
      conflict,
    );
    await expect(
      runSerializableTransaction(configuredPrisma, async () => 'committed', {
        maxAttempts: 5,
        retryDelayMs: (attempt) => {
          delayedAttempts.push(attempt);

          return 0;
        },
      }),
    ).resolves.toBe('committed');
    expect(defaultAttempts).toBe(3);
    expect(configuredAttempts).toBe(5);
    expect(delayedAttempts).toEqual([1, 2, 3, 4]);
  });
});
