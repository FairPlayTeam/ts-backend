import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import {
  searchPublicCreators,
  type PublicCreatorSearchReader,
  type PublicCreatorSearchRecord,
  type PublicCreatorSearchTransactionRunner,
} from '../src/services/videos/publicCreatorSearch.js';
import { PUBLIC_CREATOR_SEARCH_LIMIT } from '../src/services/videos/videoSearch.js';

describe('public creator search', () => {
  test('prioritizes the exact username and de-duplicates partial matches only by username', async () => {
    let exactArgs: unknown;
    let partialArgs: unknown;
    let transactionOptions: unknown;
    const operationOrder: string[] = [];
    const exactRecord: PublicCreatorSearchRecord & {
      id: string;
      email: string;
      role: string;
      isBanned: boolean;
      isVerified: boolean;
    } = {
      id: 'internal-account-id',
      email: 'must-not-leak@example.com',
      role: 'admin',
      isBanned: false,
      isVerified: true,
      username: 'needle',
      displayName: 'Exact creator',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      mediaAssets: [{ id: 'avatar-asset-id' }],
      _count: { followers: 12, videos: 4 },
    };
    const partialRecords: PublicCreatorSearchRecord[] = [
      {
        username: 'needle',
        displayName: 'Unexpected duplicate',
        createdAt: new Date('2025-02-01T00:00:00.000Z'),
        mediaAssets: [],
        _count: { followers: 1, videos: 1 },
      },
      {
        username: 'alpha_needle',
        displayName: null,
        createdAt: new Date('2025-03-01T00:00:00.000Z'),
        mediaAssets: [],
        _count: { followers: 3, videos: 2 },
      },
      {
        username: 'display_match',
        displayName: 'Needle creator',
        createdAt: new Date('2025-04-01T00:00:00.000Z'),
        mediaAssets: [],
        _count: { followers: 5, videos: 6 },
      },
      {
        username: 'second_display_match',
        displayName: 'Needle creator',
        createdAt: new Date('2025-05-01T00:00:00.000Z'),
        mediaAssets: [],
        _count: { followers: 7, videos: 8 },
      },
    ];
    const transaction: PublicCreatorSearchReader = {
      findExact: async (args) => {
        operationOrder.push('findFirst');
        exactArgs = args;
        return exactRecord;
      },
      findPartial: async (args) => {
        operationOrder.push('findMany');
        partialArgs = args;
        return partialRecords;
      },
    };
    const transactionRunner: PublicCreatorSearchTransactionRunner = {
      run: async (callback, options) => {
        transactionOptions = options;

        return callback(transaction);
      },
    };

    const creators = await searchPublicCreators(transactionRunner, '  NEEDLE  ');
    const expectedCreatorSelect = {
      username: true,
      displayName: true,
      createdAt: true,
      mediaAssets: {
        where: { kind: 'avatar' },
        select: { id: true },
        take: 1,
      },
      _count: {
        select: {
          followers: true,
          videos: {
            where: {
              visibility: 'public',
              moderationStatus: 'approved',
              processingStatus: 'ready',
            },
          },
        },
      },
    };

    expect(exactArgs).toEqual({
      where: {
        isVerified: true,
        isBanned: false,
        username: 'needle',
      },
      select: expectedCreatorSelect,
    });
    expect(partialArgs).toEqual({
      where: {
        AND: [
          {
            isVerified: true,
            isBanned: false,
          },
          {
            OR: [
              { username: { contains: 'NEEDLE', mode: 'insensitive' } },
              { displayName: { contains: 'NEEDLE', mode: 'insensitive' } },
            ],
          },
          {
            NOT: { username: 'needle' },
          },
        ],
      },
      select: expectedCreatorSelect,
      orderBy: { username: 'asc' },
      take: PUBLIC_CREATOR_SEARCH_LIMIT - 1,
    });
    expect(operationOrder).toEqual(['findFirst', 'findMany']);
    expect(transactionOptions).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(creators).toEqual([
      {
        username: 'needle',
        displayName: 'Exact creator',
        avatarUrl: '/profiles/needle/avatar',
        followerCount: 12,
        videoCount: 4,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      },
      {
        username: 'alpha_needle',
        displayName: null,
        avatarUrl: null,
        followerCount: 3,
        videoCount: 2,
        createdAt: new Date('2025-03-01T00:00:00.000Z'),
      },
      {
        username: 'display_match',
        displayName: 'Needle creator',
        avatarUrl: null,
        followerCount: 5,
        videoCount: 6,
        createdAt: new Date('2025-04-01T00:00:00.000Z'),
      },
      {
        username: 'second_display_match',
        displayName: 'Needle creator',
        avatarUrl: null,
        followerCount: 7,
        videoCount: 8,
        createdAt: new Date('2025-05-01T00:00:00.000Z'),
      },
    ]);
    expect(
      creators
        .filter(({ displayName }) => displayName === 'Needle creator')
        .map(({ username }) => username),
    ).toEqual(['display_match', 'second_display_match']);
    expect(creators[0]).not.toHaveProperty('id');
    expect(creators[0]).not.toHaveProperty('email');
    expect(creators[0]).not.toHaveProperty('role');
    expect(creators[0]).not.toHaveProperty('isBanned');
    expect(creators[0]).not.toHaveProperty('isVerified');
  });

  test('uses the full partial-match limit when there is no exact username match', async () => {
    let partialArgs: { take?: number } | undefined;
    const transaction: PublicCreatorSearchReader = {
      findExact: async () => null,
      findPartial: async (args) => {
        partialArgs = args;
        return [];
      },
    };
    const transactionRunner: PublicCreatorSearchTransactionRunner = {
      run: (callback) => callback(transaction),
    };

    await expect(searchPublicCreators(transactionRunner, 'needle')).resolves.toEqual([]);
    expect(partialArgs?.take).toBe(PUBLIC_CREATOR_SEARCH_LIMIT);
  });

  test('returns no creators and performs no reads for an empty service search', async () => {
    let calls = 0;
    const transactionRunner: PublicCreatorSearchTransactionRunner = {
      run: () => {
        calls += 1;

        return Promise.reject(new Error('Unexpected creator search transaction'));
      },
    };

    await expect(searchPublicCreators(transactionRunner, '   ')).resolves.toEqual([]);
    expect(calls).toBe(0);
  });
});
