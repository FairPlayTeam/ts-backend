import { describe, expect, test } from 'bun:test';
import {
  buildVideoArtifactManifest,
  videoHlsSegmentObjectKey,
  videoOriginalKey,
  videoSourceThumbnailKey,
  type VideoArtifactProfile,
} from '../src/services/videos/videoObjectKeys.js';

const userId = 'user-123';
const videoId = 'video-456';
const publicToken = 'a'.repeat(64);

const profiles: VideoArtifactProfile[] = [
  {
    quality: '480p',
    width: 854,
    height: 480,
    videoBitrate: 1_400_000,
  },
  {
    quality: '720p',
    width: 1280,
    height: 720,
    videoBitrate: 2_800_000,
  },
];

describe('video object keys', () => {
  test('generates an immutable source key scoped to the upload session', () => {
    expect(videoOriginalKey(userId, videoId, 'upload-789')).toBe(
      'user-123/video-456/sources/upload-789/original.mp4',
    );
  });

  test('generates an immutable source thumbnail key scoped to the upload session', () => {
    expect(videoSourceThumbnailKey(userId, videoId, 'upload-123', 'thumbnail-456')).toBe(
      'user-123/video-456/sources/upload-123/thumbnails/thumbnail-456.webp',
    );
    expect(() => videoSourceThumbnailKey(userId, videoId, 'upload-123', '../thumbnail')).toThrow(
      'thumbnailId',
    );
  });

  test('builds one immutable artifact manifest for a generation', () => {
    const manifest = buildVideoArtifactManifest(publicToken, profiles);

    expect(manifest).toEqual({
      hlsPrefix: `artifacts/${publicToken}/hls/`,
      master: {
        objectKey: `artifacts/${publicToken}/hls/master.m3u8`,
        relativePath: 'hls/master.m3u8',
      },
      thumbnailPrefix: `artifacts/${publicToken}/thumbnail/`,
      thumbnail: {
        objectKey: `artifacts/${publicToken}/thumbnail/poster.webp`,
        relativePath: 'thumbnail/poster.webp',
      },
      renditions: [
        {
          quality: '480p',
          width: 854,
          height: 480,
          videoBitrate: 1_400_000,
          playlistObjectKey: `artifacts/${publicToken}/hls/480p/index.m3u8`,
          playlistRelativePath: 'hls/480p/index.m3u8',
          segmentPrefix: `artifacts/${publicToken}/hls/480p/segments/`,
          segmentRelativeDirectory: 'hls/480p/segments',
        },
        {
          quality: '720p',
          width: 1280,
          height: 720,
          videoBitrate: 2_800_000,
          playlistObjectKey: `artifacts/${publicToken}/hls/720p/index.m3u8`,
          playlistRelativePath: 'hls/720p/index.m3u8',
          segmentPrefix: `artifacts/${publicToken}/hls/720p/segments/`,
          segmentRelativeDirectory: 'hls/720p/segments',
        },
      ],
    });
    expect(JSON.stringify(manifest)).not.toContain(userId);
    expect(JSON.stringify(manifest)).not.toContain(videoId);
  });

  test('builds the standard immutable rendition keys for 240p', () => {
    const manifest = buildVideoArtifactManifest(publicToken, [
      {
        quality: '240p',
        width: 426,
        height: 240,
        videoBitrate: 700_000,
      },
    ]);

    expect(manifest.renditions[0]).toMatchObject({
      quality: '240p',
      playlistObjectKey: `artifacts/${publicToken}/hls/240p/index.m3u8`,
      playlistRelativePath: 'hls/240p/index.m3u8',
      segmentPrefix: `artifacts/${publicToken}/hls/240p/segments/`,
      segmentRelativeDirectory: 'hls/240p/segments',
    });
  });

  test('rejects path separators and empty dynamic key segments', () => {
    expect(() => videoOriginalKey(userId, videoId, 'nested/upload')).toThrow('uploadSessionId');
    expect(() => buildVideoArtifactManifest('nested\\generation', [])).toThrow('publicToken');
    expect(() => buildVideoArtifactManifest('A'.repeat(64), [])).toThrow('publicToken');
    expect(() => buildVideoArtifactManifest('a'.repeat(63), [])).toThrow('publicToken');
    expect(() => videoOriginalKey('', videoId, 'upload')).toThrow('userId');
  });

  test('builds segment keys only from a manifest rendition and an exact generated name', () => {
    const rendition = buildVideoArtifactManifest(publicToken, profiles).renditions[0];

    expect(rendition).toBeDefined();
    expect(videoHlsSegmentObjectKey(rendition!, 'segment-00042.ts')).toBe(
      `artifacts/${publicToken}/hls/480p/segments/segment-00042.ts`,
    );
    expect(() => videoHlsSegmentObjectKey(rendition!, '../segment-00042.ts')).toThrow(
      'segmentName',
    );
    expect(() => videoHlsSegmentObjectKey(rendition!, 'segment-42.ts')).toThrow('segmentName');
  });
});
