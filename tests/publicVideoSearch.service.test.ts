import { describe, expect, test } from 'bun:test';
import {
  searchPublicVideoCatalog,
  type PublicVideoSearchDependencies,
  type PublicVideoSearchPageInput,
} from '../src/services/videos/publicVideoSearch.js';
import type { SearchPublicVideosInput } from '../src/services/videos.types.js';

const createdAt = new Date('2026-01-03T00:00:00.000Z');

const video = {
  publicId: 'PublicVid01_',
  title: 'Public search video 1',
  description: 'Launch recap in the description',
  tags: ['public-video-tag'],
  username: 'video_owner',
  thumbnailPath: '/videos/PublicVid01_/thumbnail',
  ratingAverage: 4.5,
  ratingCount: 2,
  publishedAt: new Date('2026-01-04T00:00:00.000Z'),
  createdAt,
};

const creator = {
  username: 'launch_creator',
  displayName: 'Launch Creator',
  avatarUrl: '/profiles/launch_creator/avatar',
  followerCount: 12,
  videoCount: 4,
  createdAt,
};

const createDependencies = () => {
  const calls = {
    creatorSearchTerms: [] as Array<string | undefined>,
    videoPageInputs: [] as PublicVideoSearchPageInput[],
  };
  const deps: PublicVideoSearchDependencies = {
    queryVideoPage: async (input) => {
      calls.videoPageInputs.push(input);

      return {
        videos: [video],
        total: 1,
        nextCursor: null,
      };
    },
    searchCreators: async (search) => {
      calls.creatorSearchTerms.push(search);

      return [creator];
    },
  };

  return { calls, deps };
};

describe('public video search service', () => {
  test('composes the video page and creator section from one search term', async () => {
    const { calls, deps } = createDependencies();

    await expect(searchPublicVideoCatalog(deps, { search: 'launch recap' })).resolves.toEqual({
      videos: [video],
      creators: [creator],
      total: 1,
      nextCursor: null,
    });
    expect(calls.videoPageInputs).toEqual([
      {
        filter: {
          OR: [
            { title: { contains: 'launch recap', mode: 'insensitive' } },
            { description: { contains: 'launch recap', mode: 'insensitive' } },
            { tags: { has: 'launch recap' } },
          ],
        },
        sort: 'newest',
      },
    ]);
    expect(calls.creatorSearchTerms).toEqual(['launch recap']);
  });

  test('forwards the established cursor, limit, and sort to the video page only', async () => {
    const { calls, deps } = createDependencies();
    const cursor = {
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      publicId: 'PublicVid02_',
    };

    await searchPublicVideoCatalog(deps, {
      search: 'video',
      cursor,
      limit: 2,
      sort: 'oldest',
    });

    expect(calls.videoPageInputs).toEqual([
      {
        filter: {
          OR: [
            { title: { contains: 'video', mode: 'insensitive' } },
            { description: { contains: 'video', mode: 'insensitive' } },
            { tags: { has: 'video' } },
          ],
        },
        cursor,
        limit: 2,
        sort: 'oldest',
      },
    ]);
    expect(calls.creatorSearchTerms).toEqual(['video']);
  });

  test('returns an empty result without invoking either reader for an empty direct-service search', async () => {
    const { calls, deps } = createDependencies();
    const input = { search: '   ' } satisfies SearchPublicVideosInput;

    await expect(searchPublicVideoCatalog(deps, input)).resolves.toEqual({
      videos: [],
      creators: [],
      total: 0,
      nextCursor: null,
    });
    expect(calls.videoPageInputs).toEqual([]);
    expect(calls.creatorSearchTerms).toEqual([]);
  });
});
