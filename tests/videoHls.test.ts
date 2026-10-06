import { describe, expect, test } from 'bun:test';
import {
  createVideoHlsGenerationToken,
  isVideoHlsGenerationToken,
  parseVideoHlsQuality,
  parseVideoHlsSegmentName,
  rewriteVideoHlsMasterPlaylist,
  rewriteVideoHlsRenditionPlaylist,
} from '../src/services/videos/videoHls.js';
import { createVideosService } from '../src/services/videos.service.js';
import { VideoNotFoundError } from '../src/services/videos.errors.js';

const publicId = 'AbCdEf123_';
const generationId = '11111111-1111-4111-8111-111111111111';
const generationToken = 'ab'.repeat(32);
const videoId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const artifactPrefix = `artifacts/${generationToken}`;

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
            publicToken: generationToken,
            bucket: 'videos',
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

const createReadableVideoAssetHarness = () => {
  const calls = {
    events: [] as string[],
    generationLookupArgs: [] as unknown[],
    headObjectKeys: [] as string[],
    readObjectInputs: [] as unknown[],
    signedObjectKeys: [] as string[],
    videoLookupArgs: [] as unknown[],
  };
  const service = createVideosService({
    prisma: {
      video: {
        findFirst: async (args: unknown) => {
          calls.videoLookupArgs.push(args);

          return {
            thumbnailObjectKey: `${artifactPrefix}/thumbnail/poster.webp`,
            moderationStatus: 'rejected',
            visibility: 'unlisted',
            activeArtifactGeneration: {
              publicToken: generationToken,
              bucket: 'videos',
              thumbnailObjectKey: `${artifactPrefix}/thumbnail/poster.webp`,
              renditions: [
                {
                  quality: 'p480',
                  width: 854,
                  height: 480,
                  bitrate: 1_400_000,
                },
              ],
            },
          };
        },
      },
      videoArtifactGeneration: {
        findFirst: async (args: unknown) => {
          calls.generationLookupArgs.push(args);

          return {
            publicToken: generationToken,
            bucket: 'videos',
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
      readObject: async (input: unknown) => {
        calls.events.push('read');
        calls.readObjectInputs.push(input);
        const objectKey = (input as { objectKey: string }).objectKey;

        return objectKey.endsWith('/master.m3u8')
          ? Buffer.from('#EXTM3U\n480p/index.m3u8\n')
          : Buffer.from('#EXTM3U\nsegments/segment-00000.ts\n');
      },
      headObject: async ({ objectKey }: { objectKey: string }) => {
        calls.events.push('head');
        calls.headObjectKeys.push(objectKey);

        return { objectKey: 'stored-object', sizeBytes: 1 };
      },
      getSignedUrl: async (objectKey: string) => {
        calls.events.push('sign');
        calls.signedObjectKeys.push(objectKey);

        return 'http://localhost/signed';
      },
    },
  } as unknown as Parameters<typeof createVideosService>[0]);

  return { calls, service };
};

describe('public video HLS helpers', () => {
  test('accepts only persisted rendition names and exact generated segment names', () => {
    expect(['240p', '480p', '720p', '1080p'].map(parseVideoHlsQuality)).toEqual([
      '240p',
      '480p',
      '720p',
      '1080p',
    ]);
    expect(parseVideoHlsSegmentName('segment-00000.ts')).toBe('segment-00000.ts');
    expect(isVideoHlsGenerationToken(generationToken)).toBe(true);
    expect(createVideoHlsGenerationToken()).toMatch(/^[0-9a-f]{64}$/u);
    expect(isVideoHlsGenerationToken(generationId)).toBe(false);
    expect(isVideoHlsGenerationToken('AB'.repeat(32))).toBe(false);

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

  test('rewrites a 240p master and rendition playlist without changing their metadata', () => {
    const masterPlaylist =
      '#EXTM3U\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=426x240,CODECS="avc1.4d401f,mp4a.40.2"\n' +
      '240p/index.m3u8\n';

    expect(
      rewriteVideoHlsMasterPlaylist(masterPlaylist, {
        publicId,
        generationToken,
        qualities: ['240p'],
      }),
    ).toBe(
      '#EXTM3U\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=426x240,CODECS="avc1.4d401f,mp4a.40.2"\n' +
        `/videos/${publicId}/hls/${generationToken}/240p/index.m3u8\n`,
    );
    expect(
      rewriteVideoHlsRenditionPlaylist('#EXTM3U\nsegments/segment-00000.ts\n', {
        publicId,
        generationToken,
        quality: '240p',
      }),
    ).toBe(`#EXTM3U\n/videos/${publicId}/hls/${generationToken}/240p/segments/segment-00000.ts\n`);
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
        generationToken,
        qualities: ['480p', '720p'],
      }),
    ).toBe(
      '#EXTM3U\r\n' +
        '#EXT-X-VERSION:3\r\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"\r\n' +
        `/videos/AbCdEf123_/hls/${generationToken}/480p/index.m3u8\r\n` +
        '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\r\n' +
        `/videos/AbCdEf123_/hls/${generationToken}/720p/index.m3u8\r\n`,
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
      generationToken,
      quality: '480p',
    });

    expect(rewritten).toContain('#EXTINF:6.006000,\n');
    expect(rewritten).toContain('#EXTINF:1.501500,\n');
    expect(rewritten).toContain('#EXT-X-INDEPENDENT-SEGMENTS\n');
    expect(rewritten).toContain(
      `/videos/AbCdEf123_/hls/${generationToken}/480p/segments/segment-00000.ts`,
    );
    expect(rewritten).not.toContain('\nsegments/');
  });

  test('rejects playlist URIs outside the generated manifest shape', () => {
    expect(() =>
      rewriteVideoHlsMasterPlaylist('#EXTM3U\n1080p/index.m3u8\n', {
        publicId: 'AbCdEf123_',
        generationToken,
        qualities: ['480p'],
      }),
    ).toThrow('unknown rendition');
    expect(() =>
      rewriteVideoHlsRenditionPlaylist('#EXTM3U\nsegments/../segment-00000.ts\n', {
        publicId: 'AbCdEf123_',
        generationToken,
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
          generationToken,
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

  test('rejects an internal generation UUID before any database or object-storage lookup', async () => {
    const { calls, service } = createHlsServiceHarness();

    await expect(
      service.getHlsRendition({
        publicId,
        generationToken: generationId,
        quality: '480p',
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundError);

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
          generationToken,
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
        generationToken,
        quality: '480p',
        segment: 'segment-00000.ts',
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundError);
    expect(calls).toEqual({
      generationLookups: 1,
      headObjectKeys: [`${artifactPrefix}/hls/480p/segments/segment-00000.ts`],
      signedObjectKeys: [],
    });
  });

  test('allows ready unlisted thumbnails regardless of rejected moderation and signs only after HEAD', async () => {
    const { calls, service } = createReadableVideoAssetHarness();

    await expect(service.getThumbnail({ publicId })).resolves.toEqual({
      url: 'http://localhost/signed',
    });
    expect(calls.events).toEqual(['head', 'sign']);
    expect(calls.headObjectKeys).toEqual([`${artifactPrefix}/thumbnail/poster.webp`]);
    expect(calls.signedObjectKeys).toEqual([`${artifactPrefix}/thumbnail/poster.webp`]);
    expect(JSON.stringify(calls.signedObjectKeys)).not.toContain(generationId);
    expect(JSON.stringify(calls.signedObjectKeys)).not.toContain(videoId);
    expect(JSON.stringify(calls.signedObjectKeys)).not.toContain(ownerId);
    expect(calls.videoLookupArgs[0]).toEqual(
      expect.objectContaining({
        where: {
          publicId,
          processingStatus: 'ready',
          visibility: { in: ['public', 'unlisted'] },
          activeArtifactGeneration: { is: { state: 'active' } },
        },
      }),
    );
    expect((calls.videoLookupArgs[0] as { where: object }).where).not.toHaveProperty(
      'moderationStatus',
    );
  });

  test('proxies and rewrites HLS playlists through bounded reads without signing them', async () => {
    const { calls, service } = createReadableVideoAssetHarness();

    await expect(service.getHlsMaster({ publicId })).resolves.toEqual({
      playlist: `#EXTM3U\n/videos/${publicId}/hls/${generationToken}/480p/index.m3u8\n`,
    });
    await expect(
      service.getHlsRendition({ publicId, generationToken, quality: '480p' }),
    ).resolves.toEqual({
      playlist: `#EXTM3U\n/videos/${publicId}/hls/${generationToken}/480p/segments/segment-00000.ts\n`,
    });
    expect(calls.events).toEqual(['read', 'read']);
    expect(calls.readObjectInputs).toEqual([
      {
        bucket: 'videos',
        objectKey: `${artifactPrefix}/hls/master.m3u8`,
        maxBytes: 512 * 1024,
      },
      {
        bucket: 'videos',
        objectKey: `${artifactPrefix}/hls/480p/index.m3u8`,
        maxBytes: 512 * 1024,
      },
    ]);
  });

  test('keeps the same readability rule for segments and signs only after object presence', async () => {
    const { calls, service } = createReadableVideoAssetHarness();

    await expect(
      service.getHlsSegment({
        publicId,
        generationToken,
        quality: '480p',
        segment: 'segment-00000.ts',
      }),
    ).resolves.toEqual({ url: 'http://localhost/signed' });
    expect(calls.events).toEqual(['head', 'sign']);
    expect(calls.signedObjectKeys).toEqual([
      `${artifactPrefix}/hls/480p/segments/segment-00000.ts`,
    ]);
    expect(JSON.stringify(calls.signedObjectKeys)).not.toContain(generationId);
    expect(JSON.stringify(calls.signedObjectKeys)).not.toContain(videoId);
    expect(JSON.stringify(calls.signedObjectKeys)).not.toContain(ownerId);
    const generationWhere = (calls.generationLookupArgs[0] as { where: object }).where;
    expect(generationWhere).toEqual({
      publicToken: generationToken,
      state: { in: ['active', 'retiring'] },
      video: {
        is: {
          publicId,
          processingStatus: 'ready',
          visibility: { in: ['public', 'unlisted'] },
        },
      },
      renditions: { some: { quality: 'p480' } },
    });
    expect(JSON.stringify(generationWhere)).not.toContain('moderationStatus');
  });
});
