import { describe, expect, it } from 'bun:test';
import {
  generateVideoPublicId,
  getPublicVideoId,
} from '../src/lib/videoIds.js';

describe('generateVideoPublicId', () => {
  it('returns a 10-character URL-safe identifier', () => {
    const id = generateVideoPublicId();

    expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(id).toHaveLength(10);
  });
});

describe('getPublicVideoId', () => {
  it('prefers the short public ID when available', () => {
    expect(
      getPublicVideoId({
        id: '22222222-2222-2222-2222-222222222222',
        publicId: 'AbCdEf123_',
      }),
    ).toBe('AbCdEf123_');
  });

  it('falls back to the UUID when the public ID is missing', () => {
    expect(
      getPublicVideoId({
        id: '22222222-2222-2222-2222-222222222222',
        publicId: null,
      }),
    ).toBe('22222222-2222-2222-2222-222222222222');
  });
});
