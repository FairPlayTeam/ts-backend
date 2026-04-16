import { describe, expect, it } from 'bun:test';
import { rewritePlaylistWithToken } from '../src/lib/hlsPlaylist.js';

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
