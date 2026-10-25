import { describe, expect, it } from 'bun:test';
import {
  hasValidStreamIdentifiers,
  isValidHlsQuality,
  isValidHlsSegmentName,
  rewritePlaylistWithToken,
} from '../src/lib/hlsPlaylist.js';

describe('rewritePlaylistWithToken', () => {
  it('adds the playback token to each URI line in a playlist', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      '720p/index.m3u8',
      '#EXTINF:6.0,',
      'segment_001.ts',
    ].join('\n');

    expect(rewritePlaylistWithToken(playlist, 'token-123')).toBe(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
        '720p/index.m3u8?token=token-123',
        '#EXTINF:6.0,',
        'segment_001.ts?token=token-123',
      ].join('\n'),
    );
  });
});

describe('isValidHlsQuality', () => {
  it('accepts configured HLS qualities', () => {
    expect(isValidHlsQuality('240p')).toBe(true);
    expect(isValidHlsQuality('480p')).toBe(true);
    expect(isValidHlsQuality('720p')).toBe(true);
    expect(isValidHlsQuality('1080p')).toBe(true);
  });

  it('rejects unsupported or traversal quality values', () => {
    expect(isValidHlsQuality('..')).toBe(false);
    expect(isValidHlsQuality('original.mp4')).toBe(false);
    expect(isValidHlsQuality('4k')).toBe(false);
    expect(isValidHlsQuality('')).toBe(false);
  });
});

describe('isValidHlsSegmentName', () => {
  it('accepts generated FFmpeg segment filenames', () => {
    expect(isValidHlsSegmentName('segment_000.ts')).toBe(true);
    expect(isValidHlsSegmentName('segment_042.ts')).toBe(true);
    expect(isValidHlsSegmentName('segment_1234.ts')).toBe(true);
  });

  it('rejects traversal paths and non-segment files', () => {
    expect(isValidHlsSegmentName('../original.mp4')).toBe(false);
    expect(isValidHlsSegmentName('..')).toBe(false);
    expect(isValidHlsSegmentName('original.mp4')).toBe(false);
    expect(isValidHlsSegmentName('index.m3u8')).toBe(false);
    expect(isValidHlsSegmentName('segment_001.ts/../../secret')).toBe(false);
  });
});

describe('hasValidStreamIdentifiers', () => {
  const validUserId = '11111111-1111-1111-1111-111111111111';
  const validVideoId = '22222222-2222-2222-2222-222222222222';

  it('accepts valid UUID pairs', () => {
    expect(hasValidStreamIdentifiers(validUserId, validVideoId)).toBe(true);
  });

  it('rejects non-UUID identifiers', () => {
    expect(hasValidStreamIdentifiers('not-a-uuid', validVideoId)).toBe(false);
    expect(hasValidStreamIdentifiers(validUserId, '../other')).toBe(false);
  });
});
