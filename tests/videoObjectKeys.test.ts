import { describe, expect, test } from 'bun:test';
import {
  buildVideoArtifactManifest,
  videoOriginalKey,
  type VideoArtifactProfile,
} from '../src/services/videos/videoObjectKeys.js';

const userId = 'user-123';
const videoId = 'video-456';

const profiles: VideoArtifactProfile[] = [
  {
    quality: '480p',
    width: 854,
    height: 480,
    bandwidth: 1_400_000,
  },
  {
    quality: '720p',
    width: 1280,
    height: 720,
    bandwidth: 2_800_000,
  },
];

describe('video object keys', () => {
  test('generates an immutable source key scoped to the upload session', () => {
    expect(videoOriginalKey(userId, videoId, 'upload-789')).toBe(
      'user-123/video-456/sources/upload-789/original.mp4',
    );
  });

  test('builds one immutable artifact manifest for a generation', () => {
    expect(buildVideoArtifactManifest(userId, videoId, 'generation-789', profiles)).toEqual({
      hlsPrefix: 'user-123/video-456/generations/generation-789/hls/',
      master: {
        objectKey: 'user-123/video-456/generations/generation-789/hls/master.m3u8',
        relativePath: 'hls/master.m3u8',
      },
      thumbnailPrefix: 'user-123/video-456/generations/generation-789/thumbnail/',
      thumbnail: {
        objectKey: 'user-123/video-456/generations/generation-789/thumbnail/poster.webp',
        relativePath: 'thumbnail/poster.webp',
      },
      renditions: [
        {
          quality: '480p',
          width: 854,
          height: 480,
          bandwidth: 1_400_000,
          playlistObjectKey: 'user-123/video-456/generations/generation-789/hls/480p/index.m3u8',
          playlistRelativePath: 'hls/480p/index.m3u8',
          segmentPrefix: 'user-123/video-456/generations/generation-789/hls/480p/segments/',
          segmentRelativeDirectory: 'hls/480p/segments',
        },
        {
          quality: '720p',
          width: 1280,
          height: 720,
          bandwidth: 2_800_000,
          playlistObjectKey: 'user-123/video-456/generations/generation-789/hls/720p/index.m3u8',
          playlistRelativePath: 'hls/720p/index.m3u8',
          segmentPrefix: 'user-123/video-456/generations/generation-789/hls/720p/segments/',
          segmentRelativeDirectory: 'hls/720p/segments',
        },
      ],
    });
  });

  test('rejects path separators and empty dynamic key segments', () => {
    expect(() => videoOriginalKey(userId, videoId, 'nested/upload')).toThrow('uploadSessionId');
    expect(() => buildVideoArtifactManifest(userId, videoId, 'nested\\generation', [])).toThrow(
      'generationId',
    );
    expect(() => videoOriginalKey('', videoId, 'upload')).toThrow('userId');
  });
});
