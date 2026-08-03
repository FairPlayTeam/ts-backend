import { describe, expect, test } from 'bun:test';
import { createVideosService } from '../src/services/videos.service.js';

const createdAt = new Date('2026-01-01T00:00:00.000Z');
const updatedAt = new Date('2026-01-02T00:00:00.000Z');
const rawThumbnailObjectKey = 'owner-id/video-id/generations/generation-id/thumbnail/poster.webp';
const rawVideo = {
  id: '22222222-2222-4222-8222-222222222222',
  publicId: 'AbCdEf123_',
  ownerId: '33333333-3333-4333-8333-333333333333',
  title: 'Asset contract',
  description: null,
  tags: [],
  license: 'all_rights_reserved' as const,
  visibility: 'unlisted' as const,
  allowComments: true,
  processingStatus: 'ready' as const,
  moderationStatus: 'rejected' as const,
  thumbnailObjectKey: rawThumbnailObjectKey,
  ratingSum: 0,
  ratingCount: 0,
  createdAt,
  updatedAt,
};

const createHarness = () => {
  const calls = {
    create: undefined as unknown,
    findMany: undefined as unknown,
  };
  const service = createVideosService({
    prisma: {
      $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
      video: {
        create: async (args: unknown) => {
          calls.create = args;

          return rawVideo;
        },
        findMany: async (args: unknown) => {
          calls.findMany = args;

          return [rawVideo];
        },
        count: async () => 1,
      },
    },
    objectStorage: {},
    publicIdGenerator: {
      generate: () => rawVideo.publicId,
    },
  } as unknown as Parameters<typeof createVideosService>[0]);

  return { calls, service };
};

describe('owner video asset contracts', () => {
  test('maps persisted thumbnail keys to relative paths for create and list responses', async () => {
    const { service } = createHarness();

    const created = await service.createVideo({
      userId: rawVideo.ownerId,
      title: rawVideo.title,
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: true,
    });
    const listed = await service.listMyVideos({ userId: rawVideo.ownerId });

    expect(created.video.thumbnailPath).toBe('/videos/AbCdEf123_/thumbnail');
    expect(created.video).not.toHaveProperty('thumbnailObjectKey');
    expect(listed.videos[0]?.thumbnailPath).toBe('/videos/AbCdEf123_/thumbnail');
    expect(listed.videos[0]).not.toHaveProperty('thumbnailObjectKey');
  });
});
