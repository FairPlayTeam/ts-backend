import { afterEach, describe, expect, it } from 'bun:test';
import {
  createPlaybackToken,
  verifyPlaybackToken,
} from '../src/lib/playbackTokens.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_PLAYBACK_TOKEN_SECRET = process.env.PLAYBACK_TOKEN_SECRET;
const ORIGINAL_PLAYBACK_TOKEN_TTL_SECONDS =
  process.env.PLAYBACK_TOKEN_TTL_SECONDS;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }

  if (ORIGINAL_PLAYBACK_TOKEN_SECRET === undefined) {
    delete process.env.PLAYBACK_TOKEN_SECRET;
  } else {
    process.env.PLAYBACK_TOKEN_SECRET = ORIGINAL_PLAYBACK_TOKEN_SECRET;
  }

  if (ORIGINAL_PLAYBACK_TOKEN_TTL_SECONDS === undefined) {
    delete process.env.PLAYBACK_TOKEN_TTL_SECONDS;
  } else {
    process.env.PLAYBACK_TOKEN_TTL_SECONDS =
      ORIGINAL_PLAYBACK_TOKEN_TTL_SECONDS;
  }
});

describe('playbackTokens', () => {
  it('creates and verifies a signed playback token', () => {
    process.env.PLAYBACK_TOKEN_SECRET = 'test-playback-secret';
    process.env.PLAYBACK_TOKEN_TTL_SECONDS = '3600';

    const token = createPlaybackToken({
      kind: 'playback',
      videoId: 'video-123',
      userId: 'user-456',
    });

    expect(verifyPlaybackToken(token)).toEqual({
      kind: 'playback',
      videoId: 'video-123',
      userId: 'user-456',
    });
  });

  it('rejects tampered playback tokens', () => {
    process.env.PLAYBACK_TOKEN_SECRET = 'test-playback-secret';

    const token = createPlaybackToken({
      kind: 'playback',
      videoId: 'video-123',
      userId: 'user-456',
    });

    expect(verifyPlaybackToken(`${token}tampered`)).toBeNull();
  });
});
