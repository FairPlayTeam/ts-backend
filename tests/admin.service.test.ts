import { describe, expect, test } from 'bun:test';
import type { AdminDependencies } from '../src/services/admin/admin.dependencies.js';
import { createAdminService } from '../src/services/admin.service.js';

const firstCreatedAt = new Date('2026-01-03T00:00:00.000Z');
const secondCreatedAt = new Date('2026-01-02T00:00:00.000Z');
const thirdCreatedAt = new Date('2026-01-01T00:00:00.000Z');
const updatedAt = new Date('2026-01-04T00:00:00.000Z');

const createAccountRecord = ({
  createdAt,
  id,
  mediaAssets = [],
}: {
  createdAt: Date;
  id: string;
  mediaAssets?: { objectKey: string }[];
}) => ({
  id,
  email: `${id}@example.com`,
  username: `user_${id.slice(0, 4)}`,
  displayName: `User ${id.slice(0, 4)}`,
  role: 'user' as const,
  isVerified: true,
  isBanned: false,
  bannedAt: null,
  createdAt,
  updatedAt,
  lastLogin: null,
  mediaAssets,
});

const createDeps = ({
  queriedAccounts = [
    createAccountRecord({
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: firstCreatedAt,
      mediaAssets: [{ objectKey: 'users/first/avatar/current.webp' }],
    }),
    createAccountRecord({
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: secondCreatedAt,
    }),
    createAccountRecord({
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: thirdCreatedAt,
      mediaAssets: [{ objectKey: 'users/extra/avatar/current.webp' }],
    }),
  ],
  total = 3,
}: {
  queriedAccounts?: ReturnType<typeof createAccountRecord>[];
  total?: number;
} = {}) => {
  const calls: {
    signedUrlObjectKeys: string[];
    transactionOperationCount?: number;
    userCount?: unknown;
    userFindMany?: unknown;
  } = {
    signedUrlObjectKeys: [],
  };
  const deps = {
    prisma: {
      $transaction: async (operations: Promise<unknown>[]) => {
        calls.transactionOperationCount = operations.length;

        return Promise.all(operations);
      },
      user: {
        findMany: async (args: unknown) => {
          calls.userFindMany = args;

          return queriedAccounts;
        },
        count: async (args?: unknown) => {
          calls.userCount = args;

          return total;
        },
      },
    },
    objectStorage: {
      getSignedUrl: async (objectKey: string) => {
        calls.signedUrlObjectKeys.push(objectKey);

        return `signed:${objectKey}`;
      },
    },
  } as unknown as AdminDependencies;

  return { calls, deps };
};

describe('admin service accounts', () => {
  test('lists accounts with stable cursor pagination and signed avatar URLs', async () => {
    const { calls, deps } = createDeps();
    const service = createAdminService(deps);

    await expect(service.listAccounts({ limit: 2 })).resolves.toEqual({
      accounts: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          email: '33333333-3333-4333-8333-333333333333@example.com',
          username: 'user_3333',
          displayName: 'User 3333',
          avatarUrl: 'signed:users/first/avatar/current.webp',
          role: 'user',
          isVerified: true,
          isBanned: false,
          bannedAt: null,
          createdAt: firstCreatedAt,
          updatedAt,
          lastLogin: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          email: '22222222-2222-4222-8222-222222222222@example.com',
          username: 'user_2222',
          displayName: 'User 2222',
          avatarUrl: null,
          role: 'user',
          isVerified: true,
          isBanned: false,
          bannedAt: null,
          createdAt: secondCreatedAt,
          updatedAt,
          lastLogin: null,
        },
      ],
      total: 3,
      nextCursor: {
        createdAt: secondCreatedAt,
        id: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(calls.userFindMany).toEqual({
      where: {},
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        role: true,
        isVerified: true,
        isBanned: true,
        bannedAt: true,
        createdAt: true,
        updatedAt: true,
        lastLogin: true,
        mediaAssets: {
          where: {
            kind: 'avatar',
          },
          select: {
            objectKey: true,
          },
          take: 1,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    });
    expect(calls.userCount).toBeUndefined();
    expect(calls.transactionOperationCount).toBe(2);
    expect(calls.signedUrlObjectKeys).toEqual(['users/first/avatar/current.webp']);
  });

  test('applies cursor filtering and caps oversized limits', async () => {
    const { calls, deps } = createDeps({ queriedAccounts: [] });
    const service = createAdminService(deps);
    const cursor = {
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
      id: '99999999-9999-4999-8999-999999999999',
    };

    await service.listAccounts({ cursor, limit: 10_000 });

    expect(calls.userFindMany).toEqual(
      expect.objectContaining({
        where: {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        },
        take: 101,
      }),
    );
  });
});
