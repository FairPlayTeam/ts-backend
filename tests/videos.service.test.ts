import { describe, expect, test } from 'bun:test';
import {
  createVideoPublicId,
  VIDEO_PUBLIC_ID_PATTERN,
} from '../src/services/videos/videoPublicId.js';

describe('video identifiers', () => {
  test('generates v1-compatible short public ids', () => {
    expect(createVideoPublicId()).toMatch(VIDEO_PUBLIC_ID_PATTERN);
  });

  test('does not collapse generated ids to a deterministic value', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createVideoPublicId()));

    expect(ids.size).toBe(100);
  });
});
