import { describe, expect, it } from 'bun:test';
import {
  computeAvgRating,
  mapMyVideoItem,
  mapPublicVideoSummary,
  mapVideoDetails,
} from '../src/lib/videoResponses.js';

const user = {
  id: '11111111-1111-1111-1111-111111111111',
  username: 'creator',
  displayName: 'Creator',
  avatarUrl: '11111111-1111-1111-1111-111111111111/profile/avatar.asset.png',
};

const baseVideo = {
  id: '22222222-2222-2222-2222-222222222222',
  publicId: 'AbCdEf123_',
  userId: user.id,
  title: 'Hello world',
  description: 'A test video',
  thumbnail: `thumbnails/${user.id}/22222222-2222-2222-2222-222222222222/thumb.jpg`,
  viewCount: 42n,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  ratings: [
    { score: 4, userId: 'viewer-a' },
    { score: 5, userId: 'viewer-b' },
  ],
  user,
};

describe('computeAvgRating', () => {
  it('returns a rounded average score', () => {
    expect(computeAvgRating(baseVideo.ratings)).toBe(4.5);
    expect(computeAvgRating([])).toBe(0);
  });
});

describe('mapPublicVideoSummary', () => {
  it('returns only the public video DTO fields', () => {
    const result = mapPublicVideoSummary(baseVideo);

    expect(result).toMatchObject({
      id: baseVideo.publicId,
      userId: baseVideo.userId,
      title: baseVideo.title,
      description: baseVideo.description,
      viewCount: '42',
      avgRating: 4.5,
      ratingsCount: 2,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
    });
    expect(result.thumbnailUrl).toContain(`/assets/videos/${user.id}/${baseVideo.id}/thumbnail/`);
    expect('thumbnail' in result).toBe(false);
    expect('ratings' in result).toBe(false);
  });
});

describe('mapVideoDetails', () => {
  it('does not expose raw ratings or internal storage fields', () => {
    const detailedVideo = {
      ...baseVideo,
      tags: ['test'],
      allowComments: true,
      license: 'cc_by',
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
      publishedAt: new Date('2025-01-03T00:00:00.000Z'),
      duration: 120,
      visibility: 'public',
      processingStatus: 'done',
      moderationStatus: 'approved',
      storagePath: 'videos/internal/original.mp4',
    };

    const result = mapVideoDetails(
      detailedVideo,
      {
        hls: {
          master: 'https://example.com/master.m3u8',
          variants: { '720p': 'https://example.com/720p/index.m3u8' },
          available: ['720p'],
          preferred: '720p',
        },
        userRating: 5,
      },
    );

    expect(result).toMatchObject({
      id: baseVideo.publicId,
      userId: baseVideo.userId,
      title: baseVideo.title,
      avgRating: 4.5,
      ratingsCount: 2,
      userRating: 5,
      allowComments: true,
      license: 'cc_by',
      visibility: 'public',
      processingStatus: 'done',
      moderationStatus: 'approved',
    });
    expect('ratings' in result).toBe(false);
    expect('thumbnail' in result).toBe(false);
    expect('storagePath' in result).toBe(false);
  });
});

describe('mapMyVideoItem', () => {
  it('returns a compact owner-facing listing DTO', () => {
    const result = mapMyVideoItem({
      ...baseVideo,
      visibility: 'private',
      processingStatus: 'processing',
      moderationStatus: 'pending',
    });

    expect(result).toMatchObject({
      id: baseVideo.publicId,
      title: baseVideo.title,
      viewCount: '42',
      avgRating: 4.5,
      ratingsCount: 2,
      visibility: 'private',
      processingStatus: 'processing',
      moderationStatus: 'pending',
    });
    expect('ratings' in result).toBe(false);
  });
});
