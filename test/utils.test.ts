import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildPublicUrl,
  getProxiedAssetUrl,
  getProxiedThumbnailUrl,
} from '../src/lib/utils.js';

const ORIGINAL_BASE_URL = process.env.BASE_URL;
const ORIGINAL_PORT = process.env.PORT;

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = ORIGINAL_BASE_URL;
  }

  if (ORIGINAL_PORT === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = ORIGINAL_PORT;
  }
});

describe('getProxiedAssetUrl', () => {
  it('uses the configured port when BASE_URL is unset', () => {
    delete process.env.BASE_URL;
    process.env.PORT = '3000';

    expect(
      getProxiedAssetUrl(
        '11111111-1111-1111-1111-111111111111',
        '11111111-1111-1111-1111-111111111111/profile/avatar.asset.png',
      ),
    ).toBe(
      'http://localhost:3000/assets/users/11111111-1111-1111-1111-111111111111/avatar/avatar.asset.png',
    );
  });
});

describe('getProxiedThumbnailUrl', () => {
  it('uses the explicit BASE_URL when present', () => {
    process.env.BASE_URL = 'https://api.example.com/';

    expect(
      getProxiedThumbnailUrl(
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'thumbnails/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/thumb.jpg',
      ),
    ).toBe(
      'https://api.example.com/assets/videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/thumbnail/thumb.jpg',
    );
  });
});

describe('buildPublicUrl', () => {
  it('builds absolute URLs from the canonical BASE_URL', () => {
    process.env.BASE_URL = 'https://api.example.com/root/';

    expect(buildPublicUrl('/stream/videos/u/v/master.m3u8')).toBe(
      'https://api.example.com/root/stream/videos/u/v/master.m3u8',
    );
  });
});
