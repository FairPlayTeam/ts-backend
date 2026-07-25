import { describe, expect, test } from 'bun:test';
import {
  parseVideoHlsQuality,
  parseVideoHlsSegmentName,
  rewriteVideoHlsMasterPlaylist,
  rewriteVideoHlsRenditionPlaylist,
} from '../src/services/videos/videoHls.js';
import { createVideosService } from '../src/services/videos.service.js';
import { VideoNotFoundError } from '../src/services/videos.errors.js';

const publicId = 'AbCdEf123_';
const generationId = '11111111-1111-4111-8111-111111111111';

const createHlsServiceHarness = () => {
  const calls = {
    generationLookups: 0,
    headObjectKeys: [] as string[],
    signedObjectKeys: [] as string[],
  };
  const service = createVideosService({
    prisma: {
      videoArtifactGeneration: {
        findFirst: async () => {
          calls.generationLookups += 1;

          return {
            id: generationId,
            bucket: 'videos',
            video: {
              id: '22222222-2222-4222-8222-222222222222',
              ownerId: '33333333-3333-4333-8333-333333333333',
            },
            renditions: [
              {
                quality: 'p480',
                width: 854,
                height: 480,
                bitrate: 1_400_000,
              },
            ],
          };
        },
      },
    },
    objectStorage: {
      headObject: async ({ objectKey }: { objectKey: string }) => {
        calls.headObjectKeys.push(objectKey);
        return null;
      },
      getSignedUrl: async (objectKey: string) => {
        calls.signedObjectKeys.push(objectKey);
        return 'http://localhost/signed';
      },
    },
  } as unknown as Parameters<typeof createVideosService>[0]);

  return { calls, service };
};

describe('public video HLS helpers', () => {
  test('accepts only persisted rendition names and exact generated segment names', () => {
    expect(['480p', '720p', '1080p'].map(parseVideoHlsQuality)).toEqual(['480p', '720p', '1080p']);
    expect(parseVideoHlsSegmentName('segment-00000.ts')).toBe('segment-00000.ts');

    for (const quality of ['p480', '480P', '../480p', '/480p', '480p/extra', '']) {
      expect(parseVideoHlsQuality(quality)).toBeNull();
    }

    for (const segment of [
      'segment-0000.ts',
      'segment-000000.ts',
      'segment-abcde.ts',
      '../segment-00000.ts',
      '/segment-00000.ts',
      'segments/segment-00000.ts',
      'segment-00000.ts/extra',
      'segment-00000.ts%00',
      '',
    ]) {
      expect(parseVideoHlsSegmentName(segment)).toBeNull();
    }
  });

  test('rewrites only master URI lines and preserves FFmpeg variant metadata byte-for-byte', () => {
    const playlist =
      '#EXTM3U\r\n' +
      '#EXT-X-VERSION:3\r\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"\r\n' +
      '480p/index.m3u8\r\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\r\n' +
      '720p/index.m3u8\r\n';

    expect(
      rewriteVideoHlsMasterPlaylist(playlist, {
        publicId: 'AbCdEf123_',
        generationId: '11111111-1111-4111-8111-111111111111',
        qualities: ['480p', '720p'],
      }),
    ).toBe(
      '#EXTM3U\r\n' +
        '#EXT-X-VERSION:3\r\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"\r\n' +
        '/videos/AbCdEf123_/hls/11111111-1111-4111-8111-111111111111/480p/index.m3u8\r\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\r\n' +
        '/videos/AbCdEf123_/hls/11111111-1111-4111-8111-111111111111/720p/index.m3u8\r\n',
    );
  });

  test('rewrites only rendition segment URI lines and preserves HLS timing metadata', () => {
    const playlist =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:6\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXT-X-INDEPENDENT-SEGMENTS\n' +
      '#EXTINF:6.006000,\n' +
      'segments/segment-00000.ts\n' +
      '#EXTINF:1.501500,\n' +
      'segments/segment-00001.ts\n' +
      '#EXT-X-ENDLIST\n';

    const rewritten = rewriteVideoHlsRenditionPlaylist(playlist, {
      publicId: 'AbCdEf123_',
      generationId: '11111111-1111-4111-8111-111111111111',
      quality: '480p',
    });

    expect(rewritten).toContain('#EXTINF:6.006000,\n');
    expect(rewritten).toContain('#EXTINF:1.501500,\n');
    expect(rewritten).toContain('#EXT-X-INDEPENDENT-SEGMENTS\n');
    expect(rewritten).toContain(
      '/videos/AbCdEf123_/hls/11111111-1111-4111-8111-111111111111/480p/segments/segment-00000.ts',
    );
    expect(rewritten).not.toContain('\nsegments/');
  });

  test('rejects playlist URIs outside the generated manifest shape', () => {
    expect(() =>
      rewriteVideoHlsMasterPlaylist('#EXTM3U\n1080p/index.m3u8\n', {
        publicId: 'AbCdEf123_',
        generationId: '11111111-1111-4111-8111-111111111111',
        qualities: ['480p'],
      }),
    ).toThrow('unknown rendition');
    expect(() =>
      rewriteVideoHlsRenditionPlaylist('#EXTM3U\nsegments/../segment-00000.ts\n', {
        publicId: 'AbCdEf123_',
        generationId: '11111111-1111-4111-8111-111111111111',
        quality: '480p',
      }),
    ).toThrow('invalid segment');
  });

  test('rejects quality containing ../ or an absolute path before any database or object-storage key resolution', async () => {
    const { calls, service } = createHlsServiceHarness();

    for (const quality of ['../480p', '/480p', 'C:\\480p']) {
      await expect(
        service.getHlsRendition({
          publicId,
          generationId,
          quality,
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundError);
    }

    expect(calls).toEqual({
      generationLookups: 0,
      headObjectKeys: [],
      signedObjectKeys: [],
    });
  });

  test('rejects segment containing ../ or an absolute path before any database or object-storage key resolution', async () => {
    const { calls, service } = createHlsServiceHarness();

    for (const segment of ['../segment-00000.ts', '/segment-00000.ts', 'C:\\segment-00000.ts']) {
      await expect(
        service.getHlsSegment({
          publicId,
          generationId,
          quality: '480p',
          segment,
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundError);
    }

    expect(calls).toEqual({
      generationLookups: 0,
      headObjectKeys: [],
      signedObjectKeys: [],
    });
  });

  test('returns not found and never signs when the segment HEAD reports absence', async () => {
    const { calls, service } = createHlsServiceHarness();

    await expect(
      service.getHlsSegment({
        publicId,
        generationId,
        quality: '480p',
        segment: 'segment-00000.ts',
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundError);
    expect(calls).toEqual({
      generationLookups: 1,
      headObjectKeys: [
        '33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222/generations/11111111-1111-4111-8111-111111111111/hls/480p/segments/segment-00000.ts',
      ],
      signedObjectKeys: [],
    });
  });
});
