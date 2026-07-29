import { describe, expect, test } from 'bun:test';
import { Prisma, type PrismaClient } from '@prisma/client';

import { runSerializableTransaction } from '../src/lib/prismaTransactions.js';

describe('Prisma transactions', () => {
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
});
