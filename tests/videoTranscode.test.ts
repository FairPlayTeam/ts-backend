import { describe, expect, test } from 'bun:test';
import {
  assertVideoArtifactSizeLimit,
  buildVideoFfprobeArguments,
  buildVideoFfmpegArguments,
  InvalidVideoSourceError,
  isTerminalVideoTranscodeError,
  parseVideoProbeOutput,
  runVideoProcess,
  selectVideoTranscodeProfiles,
  VideoArtifactSizeExceededError,
  VideoProcessExecutionError,
  VideoProcessTimeoutError,
  VideoSourceLimitExceededError,
  VideoSourceResolutionTooLowError,
  type VideoTranscodeLimits,
} from '../src/services/videos/videoTranscode.js';
import {
  getAvailableVideoTranscodeSlots,
  getVideoTranscodeRetryDelayMs,
} from '../src/services/videos/videoTranscodeRunner.js';
import { buildVideoArtifactManifest } from '../src/services/videos/videoObjectKeys.js';

const posixTest = process.platform === 'win32' ? test.skip : test;

const VIDEO_TRANSCODE_LIMITS = {
  ffmpegTimeoutMs: 6 * 60 * 60 * 1000,
  ffprobeTimeoutMs: 30_000,
  maxArtifactBytes: 8 * 1024 * 1024 * 1024,
  maxAspectRatio: 4,
  maxDurationSeconds: 3600,
  maxFps: 60,
  maxHeight: 3840,
  maxPixels: 3840 * 2160,
  maxWidth: 3840,
} satisfies VideoTranscodeLimits;

const squarePixelDimensions = (width: number, height: number) => ({
  width,
  height,
  displayWidth: width,
  displayHeight: height,
});

describe('video transcode profiles', () => {
  test('selects the exact ladder at every source-height boundary', () => {
    expect(() =>
      selectVideoTranscodeProfiles({
        ...squarePixelDimensions(426, 239),
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
        selectVideoTranscodeProfiles(
          squarePixelDimensions(Math.round((height * 16) / 9), height),
        ).map(({ quality }) => quality),
      ).toEqual([...qualities]);
    }
  });

  test('downscales an intermediate 280p source to 240p without adding 480p', () => {
    expect(
      selectVideoTranscodeProfiles({
        ...squarePixelDimensions(498, 280),
      }),
    ).toEqual([
      {
        quality: '240p',
        width: 426,
        height: 240,
        videoBitrate: 700_000,
      },
    ]);
  });

  test('keeps existing rendition selection unchanged and output dimensions even', () => {
    expect(
      selectVideoTranscodeProfiles({
        ...squarePixelDimensions(853, 480),
      }),
    ).toEqual([
      {
        quality: '480p',
        width: 852,
        height: 480,
        videoBitrate: 1_400_000,
      },
    ]);
    expect(
      selectVideoTranscodeProfiles({
        ...squarePixelDimensions(1281, 721),
      }),
    ).toEqual([
      {
        quality: '480p',
        width: 852,
        height: 480,
        videoBitrate: 1_400_000,
      },
      {
        quality: '720p',
        width: 1278,
        height: 720,
        videoBitrate: 2_800_000,
      },
    ]);
    expect(
      selectVideoTranscodeProfiles({
        ...squarePixelDimensions(1920, 1080),
      }).map(({ quality, height, videoBitrate }) => ({ quality, height, videoBitrate })),
    ).toEqual([
      { quality: '480p', height: 480, videoBitrate: 1_400_000 },
      { quality: '720p', height: 720, videoBitrate: 2_800_000 },
      { quality: '1080p', height: 1080, videoBitrate: 5_000_000 },
    ]);
  });

  test('parses and validates ffprobe metadata before encoding', () => {
    expect(
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              width: 1920,
              height: 1080,
              avg_frame_rate: '30000/1001',
            },
            { codec_type: 'audio' },
          ],
          format: { duration: '12.25' },
        }),
        VIDEO_TRANSCODE_LIMITS,
      ),
    ).toEqual({
      width: 1920,
      height: 1080,
      durationSeconds: 12.25,
      displayWidth: 1920,
      displayHeight: 1080,
      hasAudio: true,
    });

    expect(() =>
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [{ codec_type: 'video', width: 0, height: 1080, avg_frame_rate: '30/1' }],
          format: { duration: '12.25' },
        }),
        VIDEO_TRANSCODE_LIMITS,
      ),
    ).toThrow('dimensions, duration, frame rate, sample aspect ratio, or rotation');
    expect(() =>
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1' }],
          format: { duration: 'NaN' },
        }),
        VIDEO_TRANSCODE_LIMITS,
      ),
    ).toThrow('dimensions, duration, frame rate, sample aspect ratio, or rotation');
  });

  test('uses sample aspect ratio for policy checks and square-pixel output dimensions', () => {
    const anamorphicProbe = parseVideoProbeOutput(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 720,
            height: 576,
            avg_frame_rate: '25/1',
            sample_aspect_ratio: '16:15',
          },
        ],
        format: { duration: '10' },
      }),
      VIDEO_TRANSCODE_LIMITS,
    );

    expect(anamorphicProbe.displayWidth).toBeCloseTo(768);
    expect(anamorphicProbe.displayHeight).toBe(576);
    expect(selectVideoTranscodeProfiles(anamorphicProbe)).toEqual([
      {
        quality: '480p',
        width: 640,
        height: 480,
        videoBitrate: 1_400_000,
      },
    ]);
  });

  test('uses container rotation for oriented display limits and rendition selection', () => {
    const rotatedProbe = parseVideoProbeOutput(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 640,
            height: 360,
            avg_frame_rate: '24/1',
            sample_aspect_ratio: '1:1',
            side_data_list: [{ rotation: -90 }],
          },
        ],
        format: { duration: '10' },
      }),
      VIDEO_TRANSCODE_LIMITS,
    );

    expect(rotatedProbe).toMatchObject({
      width: 640,
      height: 360,
      displayWidth: 360,
      displayHeight: 640,
    });
    expect(selectVideoTranscodeProfiles(rotatedProbe)).toEqual([
      {
        quality: '480p',
        width: 270,
        height: 480,
        videoBitrate: 1_400_000,
      },
    ]);

    const upsideDownProbe = parseVideoProbeOutput(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 640,
            height: 360,
            avg_frame_rate: '24/1',
            sample_aspect_ratio: '1:1',
            side_data_list: [{ rotation: 180 }],
          },
        ],
        format: { duration: '10' },
      }),
      VIDEO_TRANSCODE_LIMITS,
    );

    expect(upsideDownProbe).toMatchObject({
      displayWidth: 640,
      displayHeight: 360,
    });
  });

  test('accepts exact media boundaries and parses rational frame rates', () => {
    expect(
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              width: 3840,
              height: 2160,
              avg_frame_rate: '60000/1000',
            },
          ],
          format: { duration: '3600' },
        }),
        VIDEO_TRANSCODE_LIMITS,
      ),
    ).toMatchObject({
      width: 3840,
      height: 2160,
      durationSeconds: 3600,
    });
    expect(
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              width: 2160,
              height: 3840,
              avg_frame_rate: '60/1',
            },
          ],
          format: { duration: '3600' },
        }),
        VIDEO_TRANSCODE_LIMITS,
      ),
    ).toMatchObject({ width: 2160, height: 3840 });

    expect(() =>
      parseVideoProbeOutput(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              width: 1920,
              height: 1080,
              avg_frame_rate: '0/0',
              r_frame_rate: '24000/1001',
            },
          ],
          format: { duration: '1' },
        }),
        VIDEO_TRANSCODE_LIMITS,
      ),
    ).not.toThrow();
  });

  test('rejects every configured source limit independently', () => {
    const cases = [
      { width: 1920, height: 1080, duration: 3600.001, fps: '30/1', expected: 'duration' },
      { width: 3841, height: 1080, duration: 10, fps: '30/1', expected: 'width' },
      { width: 1080, height: 3841, duration: 10, fps: '30/1', expected: 'height' },
      { width: 3000, height: 3000, duration: 10, fps: '30/1', expected: 'pixel count' },
      { width: 2000, height: 400, duration: 10, fps: '30/1', expected: 'aspect ratio' },
      { width: 400, height: 2000, duration: 10, fps: '30/1', expected: 'aspect ratio' },
      {
        width: 640,
        height: 480,
        duration: 10,
        fps: '30/1',
        sar: '4:1',
        expected: 'aspect ratio',
      },
      {
        width: 800,
        height: 3000,
        duration: 10,
        fps: '30/1',
        sar: '4:1',
        expected: 'display pixel count',
      },
      {
        width: 1921,
        height: 1000,
        duration: 10,
        fps: '30/1',
        sar: '2:1',
        rotation: 90,
        expected: 'display height',
      },
      { width: 1920, height: 1080, duration: 10, fps: '60001/1000', expected: 'frame rate' },
    ] as const;

    for (const testCase of cases) {
      expect(() =>
        parseVideoProbeOutput(
          JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                width: testCase.width,
                height: testCase.height,
                avg_frame_rate: testCase.fps,
                sample_aspect_ratio: 'sar' in testCase ? testCase.sar : '1:1',
                ...('rotation' in testCase
                  ? { side_data_list: [{ rotation: testCase.rotation }] }
                  : {}),
              },
            ],
            format: { duration: String(testCase.duration) },
          }),
          VIDEO_TRANSCODE_LIMITS,
        ),
      ).toThrow(testCase.expected);
    }
  });

  test('rejects a missing or malformed frame rate as invalid media', () => {
    for (const frameRate of [undefined, '0/0', '30/0', 'NaN', '-1/1']) {
      expect(() =>
        parseVideoProbeOutput(
          JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                width: 1920,
                height: 1080,
                avg_frame_rate: frameRate,
              },
            ],
            format: { duration: '10' },
          }),
          VIDEO_TRANSCODE_LIMITS,
        ),
      ).toThrow(InvalidVideoSourceError);
    }
  });

  test('rejects a malformed sample aspect ratio as invalid media', () => {
    for (const sampleAspectRatio of ['1:0', 'NaN', '-1:1', '1/1']) {
      expect(() =>
        parseVideoProbeOutput(
          JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                width: 1920,
                height: 1080,
                avg_frame_rate: '30/1',
                sample_aspect_ratio: sampleAspectRatio,
              },
            ],
            format: { duration: '10' },
          }),
          VIDEO_TRANSCODE_LIMITS,
        ),
      ).toThrow(InvalidVideoSourceError);
    }
  });

  test('rejects non-quarter-turn or conflicting display rotations as invalid media', () => {
    for (const sideDataList of [
      [{ rotation: 45 }],
      [{ rotation: 'NaN' }],
      [{ rotation: 90 }, { rotation: 180 }],
    ]) {
      expect(() =>
        parseVideoProbeOutput(
          JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                width: 1920,
                height: 1080,
                avg_frame_rate: '30/1',
                sample_aspect_ratio: '1:1',
                side_data_list: sideDataList,
              },
            ],
            format: { duration: '10' },
          }),
          VIDEO_TRANSCODE_LIMITS,
        ),
      ).toThrow(InvalidVideoSourceError);
    }
  });

  test('restricts ffprobe inputs to local MP4-family files and bounds decoder pixels', () => {
    const args = buildVideoFfprobeArguments('C:\\temp\\source.mp4', VIDEO_TRANSCODE_LIMITS);
    const protocolWhitelistIndex = args.indexOf('-protocol_whitelist');
    const formatWhitelistIndex = args.indexOf('-format_whitelist');
    const maxPixelsIndex = args.indexOf('-max_pixels');
    const inputIndex = args.indexOf('C:\\temp\\source.mp4');

    expect(args[protocolWhitelistIndex + 1]).toBe('file');
    expect(args[formatWhitelistIndex + 1]).toBe('mov');
    expect(args[maxPixelsIndex + 1]).toBe('8294400');
    expect(protocolWhitelistIndex).toBeLessThan(inputIndex);
    expect(formatWhitelistIndex).toBeLessThan(inputIndex);
    expect(maxPixelsIndex).toBeLessThan(inputIndex);
    expect(args).toContain(
      'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio:stream_side_data=rotation',
    );
  });

  test('builds one direct ffmpeg invocation with bounded threads, HLS VOD, audio, and thumbnail', () => {
    const probe = {
      width: 1920,
      height: 1080,
      durationSeconds: 10,
      displayWidth: 1920,
      displayHeight: 1080,
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
      limits: VIDEO_TRANSCODE_LIMITS,
      manifest,
      outputDirectory: 'C:\\temp\\artifacts',
      probe,
      threads: 3,
    });

    expect(args.filter((argument) => argument === '-threads')).toHaveLength(4);
    expect(args.filter((argument) => argument === '3').length).toBeGreaterThanOrEqual(6);
    expect(args.filter((argument) => argument === '-c:a')).toHaveLength(3);
    expect(args.filter((argument) => argument === '128000')).toHaveLength(3);
    expect(args.filter((argument) => argument === '-hls_time')).toHaveLength(3);
    expect(
      args.flatMap((argument, index) => (argument === '-hls_time' ? [args[index + 1]] : [])),
    ).toEqual(['6', '6', '6']);
    expect(args.filter((argument) => argument === '-hls_playlist_type')).toHaveLength(3);
    expect(args.filter((argument) => argument === 'vod')).toHaveLength(3);
    expect(args).toContain('libwebp');
    expect(args.filter((argument) => argument === '-maxrate')).toHaveLength(3);
    expect(args.filter((argument) => argument === '-bufsize')).toHaveLength(3);
    expect(args.filter((argument) => argument === '-fpsmax')).toHaveLength(3);
    expect(args.filter((argument) => argument === '-t')).toHaveLength(3);
    expect(
      args.flatMap((argument, index) => (argument === '-fpsmax' ? [args[index + 1]] : [])),
    ).toEqual(['60', '60', '60']);
    expect(
      args.flatMap((argument, index) => (argument === '-maxrate' ? [args[index + 1]] : [])),
    ).toEqual(['1400000', '2800000', '5000000']);
    expect(
      args.flatMap((argument, index) => (argument === '-bufsize' ? [args[index + 1]] : [])),
    ).toEqual(['2800000', '5600000', '10000000']);
    expect(args.flatMap((argument, index) => (argument === '-t' ? [args[index + 1]] : []))).toEqual(
      ['3600', '3600', '3600'],
    );
    const inputIndex = args.indexOf('-i');
    const protocolWhitelistIndex = args.indexOf('-protocol_whitelist');
    const formatWhitelistIndex = args.indexOf('-format_whitelist');
    const maxPixelsIndex = args.indexOf('-max_pixels');
    expect(args[protocolWhitelistIndex + 1]).toBe('file');
    expect(args[formatWhitelistIndex + 1]).toBe('mov');
    expect(args[maxPixelsIndex + 1]).toBe('8294400');
    expect(protocolWhitelistIndex).toBeLessThan(inputIndex);
    expect(formatWhitelistIndex).toBeLessThan(inputIndex);
    expect(maxPixelsIndex).toBeLessThan(inputIndex);
    expect(args.indexOf('-autorotate')).toBeLessThan(inputIndex);
    expect(args.join(' ')).toContain('scale=w=852:h=480:flags=lanczos,setsar=1');
    expect(args.join(' ')).toContain('scale=w=1280:h=720:flags=lanczos,setsar=1');
    expect(args.join(' ')).toContain('scale=w=1920:h=1080:flags=lanczos,setsar=1');
    expect([...args.join(' ').matchAll(/setsar=1/gu)]).toHaveLength(4);
  });

  test('omits audio encoding when ffprobe found no audio stream', () => {
    const probe = {
      width: 640,
      height: 480,
      durationSeconds: 10,
      displayWidth: 640,
      displayHeight: 480,
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
      limits: VIDEO_TRANSCODE_LIMITS,
      manifest,
      outputDirectory: 'C:\\temp\\artifacts',
      probe,
      threads: 1,
    });

    expect(args.filter((argument) => argument === '-an')).toHaveLength(1);
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('128000');
  });

  test('does not ask ffmpeg for a poster when a normalized source thumbnail is provided', () => {
    const probe = {
      width: 640,
      height: 480,
      durationSeconds: 10,
      displayWidth: 640,
      displayHeight: 480,
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
      limits: VIDEO_TRANSCODE_LIMITS,
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

describe('video transcode process and artifact limits', () => {
  test('rejects an invalid process timeout before spawning', async () => {
    await expect(
      runVideoProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        signal: new AbortController().signal,
        timeoutMs: 0,
      }),
    ).rejects.toThrow('Invalid video process timeout');
  });

  test('terminates a real child process after its own timeout', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();

    await expect(
      runVideoProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => undefined, 1000)'],
        signal: controller.signal,
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(VideoProcessTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test('preserves ordinary process exit codes', async () => {
    await expect(
      runVideoProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      exitCode: 7,
      terminationSignal: null,
    });
  });

  posixTest('preserves the signal delivered to a real externally terminated child', async () => {
    await expect(
      runVideoProcess({
        command: process.execPath,
        args: ['-e', "process.kill(process.pid, 'SIGKILL')"],
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      exitCode: null,
      terminationSignal: 'SIGKILL',
    });
  });

  test('caps the cumulative artifact size before upload', () => {
    expect(() =>
      assertVideoArtifactSizeLimit([{ sizeBytes: 40 }, { sizeBytes: 60 }], 100),
    ).not.toThrow();
    expect(() => assertVideoArtifactSizeLimit([{ sizeBytes: 40 }, { sizeBytes: 61 }], 100)).toThrow(
      VideoArtifactSizeExceededError,
    );
  });

  test('classifies deterministic media failures as terminal', () => {
    expect(isTerminalVideoTranscodeError(new InvalidVideoSourceError('invalid'))).toBe(true);
    expect(isTerminalVideoTranscodeError(new VideoSourceLimitExceededError('duration'))).toBe(true);
    expect(isTerminalVideoTranscodeError(new VideoArtifactSizeExceededError(100))).toBe(true);
    expect(
      isTerminalVideoTranscodeError(new VideoProcessExecutionError('ffmpeg', 1, null, 'bad')),
    ).toBe(false);
    expect(
      isTerminalVideoTranscodeError(new VideoProcessExecutionError('ffprobe', null, 'SIGKILL', '')),
    ).toBe(false);
    expect(isTerminalVideoTranscodeError(new VideoProcessTimeoutError('ffmpeg', 100))).toBe(true);
    expect(isTerminalVideoTranscodeError(new Error('spawn failed'))).toBe(false);
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
