import { describe, expect, test } from 'bun:test';
import {
  profileAvatarPath,
  profileBannerPath,
  readForProxy,
  resolveBestEffortLink,
  resolveSignedRedirect,
  videoHlsMasterPath,
  videoThumbnailPath,
} from '../src/services/assets/assetLinks.js';

const reference = {
  bucket: 'media',
  objectKey: 'users/user-id/avatar/current.webp',
};

describe('asset links', () => {
  test('builds encoded relative same-origin paths', () => {
    expect(profileAvatarPath('creator/name')).toBe('/profiles/creator%2Fname/avatar');
    expect(profileBannerPath('créateur')).toBe('/profiles/cr%C3%A9ateur/banner');
    expect(videoThumbnailPath('public/id')).toBe('/videos/public%2Fid/thumbnail');
    expect(videoHlsMasterPath('public/id')).toBe('/videos/public%2Fid/hls/master.m3u8');
  });

  test('resolves links solely from persisted reference presence', () => {
    expect(resolveBestEffortLink({ id: 'asset-id' }, '/profiles/creator/avatar')).toBe(
      '/profiles/creator/avatar',
    );
    expect(resolveBestEffortLink(null, '/profiles/creator/avatar')).toBeNull();
    expect(resolveBestEffortLink(undefined, '/profiles/creator/avatar')).toBeNull();
  });

  test('reads proxy bytes through the provided storage port with an explicit bound', async () => {
    const calls: unknown[] = [];
    const body = Buffer.from('image');
    const result = await readForProxy(
      {
        readObject: async (input) => {
          calls.push(input);
          return body;
        },
      },
      reference,
      1024,
    );

    expect(result).toBe(body);
    expect(calls).toEqual([{ ...reference, maxBytes: 1024 }]);
  });

  test('preserves missing proxy objects as null and propagates read failures', async () => {
    await expect(
      readForProxy({ readObject: async () => null }, reference, 1024),
    ).resolves.toBeNull();

    const failure = new Error('storage unavailable');
    await expect(
      readForProxy(
        {
          readObject: async () => {
            throw failure;
          },
        },
        reference,
        1024,
      ),
    ).rejects.toBe(failure);
  });

  test('checks existence before signing redirects', async () => {
    const calls: unknown[] = [];
    const result = await resolveSignedRedirect(
      {
        headObject: async (input) => {
          calls.push(['head', input]);
          return { objectKey: input.objectKey, sizeBytes: 42 };
        },
        getSignedUrl: async (objectKey, bucket) => {
          calls.push(['sign', objectKey, bucket]);
          return 'https://storage.test/signed';
        },
      },
      reference,
    );

    expect(result).toBe('https://storage.test/signed');
    expect(calls).toEqual([
      ['head', reference],
      ['sign', reference.objectKey, reference.bucket],
    ]);
  });

  test('does not sign missing redirect targets and propagates HEAD failures', async () => {
    let signed = false;
    await expect(
      resolveSignedRedirect(
        {
          headObject: async () => null,
          getSignedUrl: async () => {
            signed = true;
            return 'unused';
          },
        },
        reference,
      ),
    ).resolves.toBeNull();
    expect(signed).toBeFalse();

    const failure = new Error('HEAD failed');
    await expect(
      resolveSignedRedirect(
        {
          headObject: async () => {
            throw failure;
          },
          getSignedUrl: async () => 'unused',
        },
        reference,
      ),
    ).rejects.toBe(failure);
  });
});
