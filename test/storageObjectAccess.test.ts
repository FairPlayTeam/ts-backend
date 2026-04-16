import { describe, expect, it } from 'bun:test';
import {
  normalizeStorageObjectName,
  parseStorageObjectTarget,
} from '../src/lib/storageObjectAccess.js';

const userId = '11111111-1111-1111-1111-111111111111';
const videoId = '22222222-2222-2222-2222-222222222222';

describe('normalizeStorageObjectName', () => {
  it('trims the raw value and removes leading slashes', () => {
    expect(normalizeStorageObjectName('  /videos/file.txt  ')).toBe(
      'videos/file.txt',
    );
  });

  it('returns null for empty values', () => {
    expect(normalizeStorageObjectName('   ')).toBeNull();
    expect(normalizeStorageObjectName(undefined)).toBeNull();
  });
});

describe('parseStorageObjectTarget', () => {
  it('parses user profile assets', () => {
    expect(
      parseStorageObjectTarget('users', `${userId}/profile/avatar.asset.png`),
    ).toEqual({
      bucket: 'users',
      kind: 'user-avatar',
      userId,
      objectName: `${userId}/profile/avatar.asset.png`,
    });

    expect(
      parseStorageObjectTarget('users', `${userId}/profile/banner.asset.webp`),
    ).toEqual({
      bucket: 'users',
      kind: 'user-banner',
      userId,
      objectName: `${userId}/profile/banner.asset.webp`,
    });
  });

  it('parses video thumbnails and derived files', () => {
    expect(
      parseStorageObjectTarget(
        'videos',
        `thumbnails/${userId}/${videoId}/thumb.jpg`,
      ),
    ).toEqual({
      bucket: 'videos',
      kind: 'video-thumbnail',
      userId,
      videoId,
      objectName: `thumbnails/${userId}/${videoId}/thumb.jpg`,
    });

    expect(
      parseStorageObjectTarget('videos', `${userId}/${videoId}/master.m3u8`),
    ).toEqual({
      bucket: 'videos',
      kind: 'video-file',
      userId,
      videoId,
      objectName: `${userId}/${videoId}/master.m3u8`,
    });
  });

  it('rejects malformed or unsafe object names', () => {
    expect(
      parseStorageObjectTarget('videos', `${userId}/${videoId}/../secret.txt`),
    ).toBeNull();
    expect(
      parseStorageObjectTarget('users', `not-a-uuid/profile/avatar.png`),
    ).toBeNull();
    expect(
      parseStorageObjectTarget('videos', `thumbnails/${userId}/${videoId}`),
    ).toBeNull();
  });
});
