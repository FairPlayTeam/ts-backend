import { describe, expect, test } from 'bun:test';
import {
  VIDEO_OBJECT_KEY_QUALITIES,
  hlsMasterKey,
  hlsSegmentPrefix,
  hlsVariantPlaylistKey,
  isVideoObjectKeyQuality,
  videoOriginalKey,
  videoThumbnailKey,
} from '../src/services/videos/videoObjectKeys.js';

describe('video object keys', () => {
  const userId = 'user-123';
  const videoId = 'video-456';

  test('generates the legacy v1 source video key without bucket prefix', () => {
    expect(videoOriginalKey(userId, videoId)).toBe('user-123/video-456/original.mp4');
  });

  test('generates the legacy v1 HLS master playlist key', () => {
    expect(hlsMasterKey(userId, videoId)).toBe('user-123/video-456/master.m3u8');
  });

  test('generates the legacy v1 HLS variant playlist keys', () => {
    expect(
      VIDEO_OBJECT_KEY_QUALITIES.map((quality) => hlsVariantPlaylistKey(userId, videoId, quality)),
    ).toEqual([
      'user-123/video-456/240p/index.m3u8',
      'user-123/video-456/480p/index.m3u8',
      'user-123/video-456/720p/index.m3u8',
      'user-123/video-456/1080p/index.m3u8',
    ]);
  });

  test('generates the legacy v1 HLS segment prefixes', () => {
    expect(
      VIDEO_OBJECT_KEY_QUALITIES.map((quality) => hlsSegmentPrefix(userId, videoId, quality)),
    ).toEqual([
      'user-123/video-456/240p/',
      'user-123/video-456/480p/',
      'user-123/video-456/720p/',
      'user-123/video-456/1080p/',
    ]);
  });

  test('generates the legacy v1 thumbnail key', () => {
    expect(videoThumbnailKey(userId, videoId, 'poster.webp')).toBe(
      'thumbnails/user-123/video-456/poster.webp',
    );
  });

  test('recognizes supported object-key qualities', () => {
    expect(isVideoObjectKeyQuality('240p')).toBe(true);
    expect(isVideoObjectKeyQuality('1080p')).toBe(true);
    expect(isVideoObjectKeyQuality('p240')).toBe(false);
    expect(isVideoObjectKeyQuality('4k')).toBe(false);
  });

  test('rejects path separators in dynamic key segments', () => {
    expect(() => videoOriginalKey('users/user-123', videoId)).toThrow('userId');
    expect(() => videoOriginalKey(userId, 'videos/video-456')).toThrow('videoId');
    expect(() => videoThumbnailKey(userId, videoId, 'nested/poster.webp')).toThrow('filename');
    expect(() => videoThumbnailKey(userId, videoId, 'nested\\poster.webp')).toThrow('filename');
  });

  test('rejects empty dynamic key segments', () => {
    expect(() => videoOriginalKey(' ', videoId)).toThrow('userId');
    expect(() => videoOriginalKey(userId, '')).toThrow('videoId');
    expect(() => videoThumbnailKey(userId, videoId, ' ')).toThrow('filename');
  });

  test('rejects unsupported HLS object-key qualities at runtime', () => {
    expect(() => hlsVariantPlaylistKey(userId, videoId, 'p240' as never)).toThrow('quality');
    expect(() => hlsSegmentPrefix(userId, videoId, '4k' as never)).toThrow('quality');
  });
});
