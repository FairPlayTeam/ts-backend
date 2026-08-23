import type { Prisma } from '@prisma/client';
import type {
  PublicVideoCursor,
  PublicVideoSearchSort,
  SearchPublicVideosInput,
  SearchPublicVideosResult,
} from './types/ports.types.js';
import { buildVideoSearchFilter } from './videoSearch.js';

export type PublicVideoSearchPageInput = {
  cursor?: PublicVideoCursor;
  filter: Prisma.VideoWhereInput;
  limit?: number;
  sort: PublicVideoSearchSort;
};

type PublicVideoSearchPageResult = Omit<SearchPublicVideosResult, 'creators'>;

export type PublicVideoSearchDependencies = {
  queryVideoPage(input: PublicVideoSearchPageInput): Promise<PublicVideoSearchPageResult>;
  searchCreators(search: string | undefined): Promise<SearchPublicVideosResult['creators']>;
};

export const searchPublicVideoCatalog = async (
  deps: PublicVideoSearchDependencies,
  { cursor, limit, search, sort = 'newest' }: SearchPublicVideosInput,
): Promise<SearchPublicVideosResult> => {
  const searchFilter = buildVideoSearchFilter(search);

  if (!searchFilter) {
    return {
      videos: [],
      creators: [],
      total: 0,
      nextCursor: null,
    };
  }

  const [page, creators] = await Promise.all([
    deps.queryVideoPage({
      filter: searchFilter,
      sort,
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    }),
    deps.searchCreators(search),
  ]);

  return {
    ...page,
    creators,
  };
};
