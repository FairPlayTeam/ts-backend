import { Prisma, type PrismaClient } from '@prisma/client';
import { PUBLIC_PROFILE_VISIBILITY_SCOPE } from '../profiles/publicProfileVisibility.js';
import {
  profileAvatarMediaAssetsSelection,
  toProfileMediaUrl,
} from '../userMedia/userMedia.profileAssets.js';
import type { PublicCreatorSearchSummary } from './types/ports.types.js';
import { publicVideoCatalogWhere } from './videoReadability.js';
import { buildPublicCreatorSearchCriteria, PUBLIC_CREATOR_SEARCH_LIMIT } from './videoSearch.js';

const publicCreatorSearchSelect = {
  username: true,
  displayName: true,
  createdAt: true,
  mediaAssets: profileAvatarMediaAssetsSelection,
  _count: {
    select: {
      followers: true,
      videos: {
        where: publicVideoCatalogWhere,
      },
    },
  },
} satisfies Prisma.UserSelect;

export type PublicCreatorSearchRecord = Prisma.UserGetPayload<{
  select: typeof publicCreatorSearchSelect;
}>;

type PublicCreatorSearchFindExactArgs = {
  where: Prisma.UserWhereInput;
  select: typeof publicCreatorSearchSelect;
};

type PublicCreatorSearchFindPartialArgs = PublicCreatorSearchFindExactArgs & {
  orderBy: Prisma.UserOrderByWithRelationInput;
  take: number;
};

export type PublicCreatorSearchReader = {
  findExact(args: PublicCreatorSearchFindExactArgs): Promise<PublicCreatorSearchRecord | null>;
  findPartial(args: PublicCreatorSearchFindPartialArgs): Promise<PublicCreatorSearchRecord[]>;
};

export type PublicCreatorSearchTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel;
};

export type PublicCreatorSearchTransactionRunner = {
  run<T>(
    callback: (reader: PublicCreatorSearchReader) => Promise<T>,
    options: PublicCreatorSearchTransactionOptions,
  ): Promise<T>;
};

const toPublicCreatorSearchReader = (
  tx: Pick<Prisma.TransactionClient, 'user'>,
): PublicCreatorSearchReader => ({
  findExact: (args) => tx.user.findFirst(args),
  findPartial: (args) => tx.user.findMany(args),
});

export const createPublicCreatorSearchTransactionRunner = (
  prisma: Pick<PrismaClient, '$transaction'>,
): PublicCreatorSearchTransactionRunner => ({
  run: (callback, options) =>
    prisma.$transaction((tx) => callback(toPublicCreatorSearchReader(tx)), options),
});

type PublicCreatorSearchRecords = {
  exactMatch: PublicCreatorSearchRecord | null;
  partialMatches: PublicCreatorSearchRecord[];
};

const toPublicCreatorSearchSummary = ({
  _count,
  createdAt,
  displayName,
  mediaAssets,
  username,
}: PublicCreatorSearchRecord): PublicCreatorSearchSummary => ({
  username,
  displayName,
  avatarUrl: toProfileMediaUrl(username, 'avatar', mediaAssets[0]),
  followerCount: _count.followers,
  videoCount: _count.videos,
  createdAt,
});

const queryPublicCreatorSearchRecords = async (
  reader: PublicCreatorSearchReader,
  exactUsername: string,
  partialSearchFilter: Prisma.UserWhereInput,
): Promise<PublicCreatorSearchRecords> => {
  const exactMatch = await reader.findExact({
    where: {
      ...PUBLIC_PROFILE_VISIBILITY_SCOPE,
      username: exactUsername,
    },
    select: publicCreatorSearchSelect,
  });
  const partialMatches = await reader.findPartial({
    where: {
      AND: [
        PUBLIC_PROFILE_VISIBILITY_SCOPE,
        partialSearchFilter,
        {
          NOT: {
            username: exactUsername,
          },
        },
      ],
    },
    select: publicCreatorSearchSelect,
    orderBy: {
      username: 'asc',
    },
    take: exactMatch ? PUBLIC_CREATOR_SEARCH_LIMIT - 1 : PUBLIC_CREATOR_SEARCH_LIMIT,
  });

  return { exactMatch, partialMatches };
};

export const searchPublicCreators = async (
  transactionRunner: PublicCreatorSearchTransactionRunner,
  search: string | undefined,
): Promise<PublicCreatorSearchSummary[]> => {
  const criteria = buildPublicCreatorSearchCriteria(search);

  if (!criteria) {
    return [];
  }

  const { exactMatch, partialMatches } = await transactionRunner.run(
    (reader) =>
      queryPublicCreatorSearchRecords(reader, criteria.exactUsername, criteria.partialFilter),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );

  const distinctPartialMatches = exactMatch
    ? partialMatches.filter(
        ({ username }) => username.toLowerCase() !== exactMatch.username.toLowerCase(),
      )
    : partialMatches;

  return [...(exactMatch ? [exactMatch] : []), ...distinctPartialMatches]
    .slice(0, PUBLIC_CREATOR_SEARCH_LIMIT)
    .map(toPublicCreatorSearchSummary);
};
