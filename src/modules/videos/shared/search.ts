import type { Prisma } from '@prisma/client';

export const PUBLIC_CREATOR_SEARCH_LIMIT = 10;

export const normalizePublicSearchTerm = (search: string | undefined): string | undefined => {
  const normalizedSearch = search?.trim();

  return normalizedSearch ? normalizedSearch : undefined;
};

export const escapeSearchTermForIlike = (search: string): string =>
  search.replace(/[\\%_]/g, '\\$&');

export const buildLiteralInsensitiveContains = (search: string): Prisma.StringFilter => ({
  contains: escapeSearchTermForIlike(search),
  mode: 'insensitive',
});

export const buildVideoSearchFilter = (
  search: string | undefined,
): Prisma.VideoWhereInput | undefined => {
  const normalizedSearch = normalizePublicSearchTerm(search);

  if (!normalizedSearch) {
    return undefined;
  }

  return {
    OR: [
      { title: buildLiteralInsensitiveContains(normalizedSearch) },
      { description: buildLiteralInsensitiveContains(normalizedSearch) },
      { tags: { has: normalizedSearch } },
    ],
  };
};

export const buildPublicCreatorSearchCriteria = (
  search: string | undefined,
):
  | {
      exactUsername: string;
      partialFilter: Prisma.UserWhereInput;
    }
  | undefined => {
  const normalizedSearch = normalizePublicSearchTerm(search);

  if (!normalizedSearch) {
    return undefined;
  }

  return {
    exactUsername: normalizedSearch.toLowerCase(),
    partialFilter: {
      OR: [
        { username: buildLiteralInsensitiveContains(normalizedSearch) },
        { displayName: buildLiteralInsensitiveContains(normalizedSearch) },
      ],
    },
  };
};
