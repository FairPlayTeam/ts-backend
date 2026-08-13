import { describe, expect, test } from 'bun:test';
import {
  buildVideoFfmpegArguments,
  parseVideoProbeOutput,
  selectVideoTranscodeProfiles,
  VideoSourceResolutionTooLowError,
} from '../src/services/videos/videoTranscode.js';
import {
  getAvailableVideoTranscodeSlots,
  getVideoTranscodeRetryDelayMs,
} from '../src/services/videos/videoTranscodeRunner.js';
import { buildVideoArtifactManifest } from '../src/services/videos/videoObjectKeys.js';

describe('video transcode profiles', () => {
  test('selects the exact ladder at every source-height boundary', () => {
    expect(() =>
      selectVideoTranscodeProfiles({
        width: 426,
        height: 239,
      }),
    ).toThrow(VideoSourceResolutionTooLowError);

    const cases = [
      { height: 240, qualities: ['240p'] },
      { height: 479, qualities: ['240p'] },
      { height: 480, qualities: ['480p'] },
      { height: 719, qualities: ['480p'] },
      { height: 720, qualities: ['480p', '720p'] },
      { height: 1079, qualities: ['480p', '720p'] },
      { height: 1080, qualities: ['480p', '720p', '1080p'] },
    ] as const;

    for (const { height, qualities } of cases) {
      expect(
        selectVideoTranscodeProfiles({ width: 1920, height }).map(({ quality }) => quality),
      ).toEqual([...qualities]);
    }
  });

  test('downscales an intermediate 280p source to 240p without adding 480p', () => {
    expect(
      selectVideoTranscodeProfiles({
        width: 498,
        height: 280,
      }),
    ).toEqual([
      {
        quality: '240p',
        width: 426,
        height: 240,
        bandwidth: 700_000,
      },
    ]);
  });

  test('keeps existing rendition selection unchanged and output dimensions even', () => {
    expect(
      selectVideoTranscodeProfiles({
        width: 853,
        height: 480,
      }),
    ).toEqual([
      {
        quality: '480p',
        width: 852,
        height: 480,
        bandwidth: 1_400_000,
      },
    ]);
    expect(
      selectVideoTranscodeProfiles({
        width: 1281,
        height: 721,
      }),
    ).toEqual([
      {
        quality: '480p',
        width: 852,
        height: 480,
        bandwidth: 1_400_000,
      },
      {
        quality: '720p',
        width: 1278,
        height: 720,
        bandwidth: 2_800_000,
      },
    ]);
    expect(
      selectVideoTranscodeProfiles({
        width: 1920,
        height: 1080,
      }).map(({ quality, height, bandwidth }) => ({ quality, height, bandwidth })),
    ).toEqual([
      { quality: '480p', height: 480, bandwidth: 1_400_000 },
      { quality: '720p', height: 720, bandwidth: 2_800_000 },
      { quality: '1080p', height: 1080, bandwidth: 5_000_000 },
    ]);
  });

  test('parses and validates ffprobe metadata before encoding', () => {
    expect(
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }],
          format: { duration: '12.25' },
        }),
      ),
    ).toEqual({
      width: 1920,
      height: 1080,
      durationSeconds: 12.25,
      hasAudio: true,
    });

    expect(() =>
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [{ codec_type: 'video', width: 0, height: 1080 }],
          format: { duration: '12.25' },
        }),
      ),
    ).toThrow('dimensions or duration');
    expect(() =>
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
          format: { duration: 'NaN' },
        }),
      ),
    ).toThrow('dimensions or duration');
  });

  test('builds one direct ffmpeg invocation with bounded threads, HLS VOD, audio, and thumbnail', () => {
    const probe = {
      width: 1920,
      height: 1080,
      durationSeconds: 10,
      hasAudio: true,
    };
    const manifest = buildVideoArtifactManifest(
      'user-id',
      'video-id',
      'generation-id',
      selectVideoTranscodeProfiles(probe),
    );
    const args = buildVideoFfmpegArguments({
      inputPath: 'C:\\temp\\source.mp4',
      manifest,
      outputDirectory: 'C:\\temp\\artifacts',
      probe,
      threads: 3,
    });

    expect(args.filter((argument) => argument === '-threads')).toHaveLength(4);
    expect(args.filter((argument) => argument === '3').length).toBeGreaterThanOrEqual(6);
    expect(args.filter((argument) => argument === '-c:a')).toHaveLength(3);
    expect(args.filter((argument) => argument === '128k')).toHaveLength(3);
    expect(args.filter((argument) => argument === '-hls_time')).toHaveLength(3);
    expect(
      args.flatMap((argument, index) => (argument === '-hls_time' ? [args[index + 1]] : [])),
    ).toEqual(['6', '6', '6']);
    expect(args.filter((argument) => argument === '-hls_playlist_type')).toHaveLength(3);
    expect(args.filter((argument) => argument === 'vod')).toHaveLength(3);
    expect(args).toContain('libwebp');
    expect(args.join(' ')).toContain('scale=w=852:h=480');
    expect(args.join(' ')).toContain('scale=w=1280:h=720');
    expect(args.join(' ')).toContain('scale=w=1920:h=1080');
  });

  test('omits audio encoding when ffprobe found no audio stream', () => {
    const probe = {
      width: 640,
      height: 480,
      durationSeconds: 10,
      hasAudio: false,
    };
    const manifest = buildVideoArtifactManifest(
      'user-id',
      'video-id',
      'generation-id',
      selectVideoTranscodeProfiles(probe),
    );
    const args = buildVideoFfmpegArguments({
      inputPath: 'C:\\temp\\source.mp4',
      manifest,
      outputDirectory: 'C:\\temp\\artifacts',
      probe,
      threads: 1,
    });

    expect(args.filter((argument) => argument === '-an')).toHaveLength(1);
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('128k');
  });

  test('does not ask ffmpeg for a poster when a normalized source thumbnail is provided', () => {
    const probe = {
      width: 640,
      height: 480,
      durationSeconds: 10,
      hasAudio: false,
    };
    const manifest = buildVideoArtifactManifest(
      'user-id',
      'video-id',
      'generation-id',
      selectVideoTranscodeProfiles(probe),
    );
    const args = buildVideoFfmpegArguments({
      generateThumbnail: false,
      inputPath: 'C:\\temp\\source.mp4',
      manifest,
      outputDirectory: 'C:\\temp\\artifacts',
      probe,
      threads: 1,
    });

    expect(args).not.toContain('libwebp');
    expect(args).not.toContain('[thumbnail]');
    expect(args.join(' ')).not.toContain('[thumbnailin]');
    expect(args.join(' ')).toContain('[0:v:0]null[rendition0in]');
  });
});

describe('video transcode runner limits', () => {
  test('is disabled at zero and never exposes more than the configured local slots', () => {
    expect(getAvailableVideoTranscodeSlots(0, 0)).toBe(0);
    expect(getAvailableVideoTranscodeSlots(2, 0)).toBe(2);
    expect(getAvailableVideoTranscodeSlots(2, 1)).toBe(1);
    expect(getAvailableVideoTranscodeSlots(2, 2)).toBe(0);
    expect(getAvailableVideoTranscodeSlots(2, 3)).toBe(0);
  });

  test('uses bounded exponential job retry backoff', () => {
    expect(getVideoTranscodeRetryDelayMs(1)).toBe(60_000);
    expect(getVideoTranscodeRetryDelayMs(2)).toBe(120_000);
    expect(getVideoTranscodeRetryDelayMs(100)).toBe(24 * 60 * 60 * 1000);
  });
});
