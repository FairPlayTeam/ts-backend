type VideoIlikeTextCondition = {
  contains: string;
  mode: 'insensitive';
};

type VideoSearchFilter = {
  OR: [
    { title: VideoIlikeTextCondition },
    { description: VideoIlikeTextCondition },
    { tags: { has: string } },
  ];
};

export const escapeVideoSearchTermForIlike = (search: string): string =>
  search.replace(/[\\%_]/g, '\\$&');

export const buildVideoSearchFilter = (
  search: string | undefined,
): VideoSearchFilter | undefined => {
  const normalizedSearch = search?.trim();

  if (!normalizedSearch) {
    return undefined;
  }

  const literalSearch = escapeVideoSearchTermForIlike(normalizedSearch);

  return {
    OR: [
      { title: { contains: literalSearch, mode: 'insensitive' } },
      { description: { contains: literalSearch, mode: 'insensitive' } },
      { tags: { has: normalizedSearch } },
    ],
  };
};
