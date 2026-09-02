import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import {
  VIDEO_HLS_SEGMENT_NAME_PATTERN,
  videoHlsSegmentObjectKey,
  type VideoArtifactManifest,
  type VideoArtifactProfile,
} from './videoObjectKeys.js';

const PROCESS_OUTPUT_LIMIT_BYTES = 256 * 1024;
const PROCESS_ABORT_KILL_DELAY_MS = 5_000;
const MAX_PROCESS_TIMEOUT_MS = 2_147_483_647;
const HLS_SEGMENT_DURATION_SECONDS = 6;
const INPUT_FORMAT_WHITELIST = 'mov';
const INPUT_PROTOCOL_WHITELIST = 'file';
const AAC_AUDIO_BITRATE_BITS_PER_SECOND = 128_000;
const HLS_BANDWIDTH_SAFETY_PERCENT = 110;

const TRANSCODE_PROFILES = [
  { quality: '240p', height: 240, videoBitrate: 700_000 },
  { quality: '480p', height: 480, videoBitrate: 1_400_000 },
  { quality: '720p', height: 720, videoBitrate: 2_800_000 },
  { quality: '1080p', height: 1080, videoBitrate: 5_000_000 },
] as const;

export type VideoProbe = {
  width: number;
  height: number;
  durationSeconds: number;
  displayWidth: number;
  displayHeight: number;
  hasAudio: boolean;
};

export type VideoTranscodeLimits = {
  ffmpegTimeoutMs: number;
  ffprobeTimeoutMs: number;
  maxArtifactBytes: number;
  maxAspectRatio: number;
  maxDurationSeconds: number;
  maxFps: number;
  maxHeight: number;
  maxPixels: number;
  maxWidth: number;
};

type GeneratedVideoArtifact = {
  objectKey: string;
  filePath: string;
  contentType: string;
  sizeBytes: number;
};

export type GeneratedVideoArtifacts = {
  files: GeneratedVideoArtifact[];
  renditionSegments: GeneratedVideoArtifact[][];
};

class VideoTranscodeAbortedError extends Error {
  constructor(options: ErrorOptions = {}) {
    super('Video transcode process was aborted', options);
    this.name = 'VideoTranscodeAbortedError';
  }
}

export class VideoProcessExecutionError extends Error {
  readonly exitCode: number | null;
  readonly terminationSignal: NodeJS.Signals | null;

  constructor(
    command: string,
    exitCode: number | null,
    terminationSignal: NodeJS.Signals | null,
    stderr: string,
  ) {
    const detail = stderr.trim();
    const termination = terminationSignal
      ? `was terminated by ${terminationSignal}`
      : `exited with code ${exitCode === null ? 'unknown' : String(exitCode)}`;
    super(`${command} ${termination}${detail ? `: ${detail}` : ''}`);
    this.name = 'VideoProcessExecutionError';
    this.exitCode = exitCode;
    this.terminationSignal = terminationSignal;
  }
}

export class VideoProcessTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = 'VideoProcessTimeoutError';
  }
}

export class InvalidVideoSourceError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'InvalidVideoSourceError';
  }
}

export class VideoSourceLimitExceededError extends InvalidVideoSourceError {
  constructor(detail: string) {
    super(`Source video exceeds transcode limits: ${detail}`);
    this.name = 'VideoSourceLimitExceededError';
  }
}

export class VideoSourceResolutionTooLowError extends InvalidVideoSourceError {
  constructor(height: number) {
    super(`Source video display height ${height}px is below the minimum supported height of 240px`);
    this.name = 'VideoSourceResolutionTooLowError';
  }
}

export class VideoArtifactSizeExceededError extends Error {
  constructor(maxArtifactBytes: number) {
    super(`Generated video artifacts exceed the ${maxArtifactBytes}-byte limit`);
    this.name = 'VideoArtifactSizeExceededError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toFiniteNumber = (value: unknown): number | null => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : null;
};

const toPositiveRational = (value: unknown, separator: '/' | ':'): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parts = value.trim().split(separator);
  const numerator = Number(parts[0]);
  const denominator = parts.length === 1 ? 1 : Number(parts[1]);

  if (
    parts.length > 2 ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }

  const ratio = numerator / denominator;

  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
};

const toSampleAspectRatio = (value: unknown): number | null => {
  if (value === undefined || value === null || value === 0) {
    return 1;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();

    if (normalized === '' || normalized === 'N/A' || /^0:\d+$/u.test(normalized)) {
      return 1;
    }
  }

  return toPositiveRational(value, ':');
};

type VideoDisplayRotation = 0 | 90 | 180 | 270;

const isVideoDisplayRotation = (value: number): value is VideoDisplayRotation =>
  value === 0 || value === 90 || value === 180 || value === 270;

const toVideoDisplayRotation = (value: unknown): VideoDisplayRotation | null => {
  const parsed = toFiniteNumber(value);

  if (parsed === null || !Number.isSafeInteger(parsed)) {
    return null;
  }

  const normalized = ((parsed % 360) + 360) % 360;

  return isVideoDisplayRotation(normalized) ? normalized : null;
};

const readVideoDisplayRotation = (
  videoStream: Record<string, unknown>,
): VideoDisplayRotation | null => {
  const rawSideData = videoStream.side_data_list;

  if (rawSideData === undefined) {
    return 0;
  }

  if (!Array.isArray(rawSideData)) {
    return null;
  }

  let rotation: VideoDisplayRotation | null = null;

  for (const sideData of rawSideData.filter(isRecord)) {
    if (!Object.hasOwn(sideData, 'rotation')) {
      continue;
    }

    const parsedRotation = toVideoDisplayRotation(sideData.rotation);

    if (parsedRotation === null || (rotation !== null && parsedRotation !== rotation)) {
      return null;
    }

    rotation = parsedRotation;
  }

  return rotation ?? 0;
};

const toBoundedOutput = (current: Buffer, chunk: Buffer): Buffer => {
  const combined = Buffer.concat([current, chunk]);

  return combined.length <= PROCESS_OUTPUT_LIMIT_BYTES
    ? combined
    : combined.subarray(combined.length - PROCESS_OUTPUT_LIMIT_BYTES);
};

export const runVideoProcess = async ({
  args,
  command,
  cwd,
  signal,
  timeoutMs,
}: {
  args: readonly string[];
  command: string;
  cwd?: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolvePromise, rejectPromise) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
      rejectPromise(new Error(`Invalid video process timeout: ${timeoutMs}ms`));
      return;
    }

    if (signal.aborted) {
      const reason: unknown = signal.reason;
      rejectPromise(
        new VideoTranscodeAbortedError(reason instanceof Error ? { cause: reason } : {}),
      );
      return;
    }

    const child = spawn(command, [...args], {
      ...(cwd ? { cwd } : {}),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let terminationReason: 'aborted' | 'timed_out' | null = null;
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = toBoundedOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = toBoundedOutput(stderr, chunk);
    });

    const cleanup = (): void => {
      signal.removeEventListener('abort', abortProcess);

      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }

      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };
    const terminateProcess = (reason: 'aborted' | 'timed_out'): void => {
      if (terminationReason) {
        return;
      }

      terminationReason = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, PROCESS_ABORT_KILL_DELAY_MS);
      killTimer.unref?.();
    };
    const abortProcess = (): void => {
      terminateProcess('aborted');
    };

    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (terminationReason === 'timed_out') {
        rejectPromise(new VideoProcessTimeoutError(command, timeoutMs));
      } else if (terminationReason === 'aborted' || signal.aborted) {
        const reason: unknown = signal.reason;
        rejectPromise(
          new VideoTranscodeAbortedError(reason instanceof Error ? { cause: reason } : {}),
        );
      } else {
        rejectPromise(error);
      }
    });
    child.once('close', (exitCode, terminationSignal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (terminationReason === 'timed_out') {
        rejectPromise(new VideoProcessTimeoutError(command, timeoutMs));
        return;
      }

      if (terminationReason === 'aborted' || signal.aborted) {
        const reason: unknown = signal.reason;
        rejectPromise(
          new VideoTranscodeAbortedError(reason instanceof Error ? { cause: reason } : {}),
        );
        return;
      }

      const stdoutText = stdout.toString('utf8');
      const stderrText = stderr.toString('utf8');

      if (exitCode !== 0) {
        rejectPromise(
          new VideoProcessExecutionError(command, exitCode, terminationSignal, stderrText),
        );
        return;
      }

      resolvePromise({ stdout: stdoutText, stderr: stderrText });
    });
    signal.addEventListener('abort', abortProcess, { once: true });
    timeoutTimer = setTimeout(() => {
      terminateProcess('timed_out');
    }, timeoutMs);
    timeoutTimer.unref?.();

    if (signal.aborted) {
      abortProcess();
    }
  });

export const parseVideoProbeOutput = (
  output: string,
  limits: Pick<
    VideoTranscodeLimits,
    'maxAspectRatio' | 'maxDurationSeconds' | 'maxFps' | 'maxHeight' | 'maxPixels' | 'maxWidth'
  >,
): VideoProbe => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new InvalidVideoSourceError('ffprobe returned invalid JSON', { cause: error });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.streams) || !isRecord(parsed.format)) {
    throw new InvalidVideoSourceError('ffprobe returned incomplete media metadata');
  }

  const streams = parsed.streams.filter(isRecord);
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const width = videoStream ? toFiniteNumber(videoStream.width) : null;
  const height = videoStream ? toFiniteNumber(videoStream.height) : null;
  const fps = videoStream
    ? (toPositiveRational(videoStream.avg_frame_rate, '/') ??
      toPositiveRational(videoStream.r_frame_rate, '/'))
    : null;
  const sampleAspectRatio = videoStream
    ? toSampleAspectRatio(videoStream.sample_aspect_ratio)
    : null;
  const displayRotation = videoStream ? readVideoDisplayRotation(videoStream) : null;
  const durationSeconds = toFiniteNumber(parsed.format.duration);

  if (
    width === null ||
    height === null ||
    fps === null ||
    sampleAspectRatio === null ||
    displayRotation === null ||
    durationSeconds === null ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 2 ||
    height < 2 ||
    durationSeconds <= 0 ||
    durationSeconds > Number.MAX_SAFE_INTEGER
  ) {
    throw new InvalidVideoSourceError(
      'ffprobe returned invalid video dimensions, duration, frame rate, sample aspect ratio, or rotation',
    );
  }

  if (durationSeconds > limits.maxDurationSeconds) {
    throw new VideoSourceLimitExceededError(
      `duration ${durationSeconds}s is above ${limits.maxDurationSeconds}s`,
    );
  }

  if (width > limits.maxWidth) {
    throw new VideoSourceLimitExceededError(`width ${width}px is above ${limits.maxWidth}px`);
  }

  if (height > limits.maxHeight) {
    throw new VideoSourceLimitExceededError(`height ${height}px is above ${limits.maxHeight}px`);
  }

  if (width > Math.floor(limits.maxPixels / height)) {
    throw new VideoSourceLimitExceededError(
      `pixel count ${width}x${height} is above ${limits.maxPixels}`,
    );
  }

  const unrotatedDisplayWidth = width * sampleAspectRatio;
  const swapsDisplayDimensions = displayRotation === 90 || displayRotation === 270;
  const displayWidth = swapsDisplayDimensions ? height : unrotatedDisplayWidth;
  const displayHeight = swapsDisplayDimensions ? unrotatedDisplayWidth : height;

  if (
    !Number.isFinite(displayWidth) ||
    !Number.isFinite(displayHeight) ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    throw new InvalidVideoSourceError('ffprobe returned invalid display dimensions');
  }

  if (displayWidth > limits.maxWidth) {
    throw new VideoSourceLimitExceededError(
      `display width ${displayWidth.toFixed(2)}px is above ${limits.maxWidth}px`,
    );
  }

  if (displayHeight > limits.maxHeight) {
    throw new VideoSourceLimitExceededError(
      `display height ${displayHeight.toFixed(2)}px is above ${limits.maxHeight}px`,
    );
  }

  if (displayWidth > limits.maxPixels / displayHeight) {
    throw new VideoSourceLimitExceededError(
      `display pixel count ${displayWidth.toFixed(2)}x${displayHeight.toFixed(2)} is above ${limits.maxPixels}`,
    );
  }

  const rasterAspectRatio = Math.max(width / height, height / width);
  const displayWidthToHeightRatio = displayWidth / displayHeight;
  const maxDisplayAspectRatio = Math.max(displayWidthToHeightRatio, 1 / displayWidthToHeightRatio);
  const effectiveAspectRatio = Math.max(rasterAspectRatio, maxDisplayAspectRatio);

  if (effectiveAspectRatio > limits.maxAspectRatio) {
    throw new VideoSourceLimitExceededError(
      `aspect ratio ${effectiveAspectRatio.toFixed(2)}:1 is above ${limits.maxAspectRatio}:1`,
    );
  }

  if (fps > limits.maxFps) {
    throw new VideoSourceLimitExceededError(
      `frame rate ${fps.toFixed(3)}fps is above ${limits.maxFps}fps`,
    );
  }

  return {
    width,
    height,
    durationSeconds,
    displayWidth,
    displayHeight,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  };
};

const buildVideoInputSafetyArguments = (maxPixels: number): string[] => [
  '-format_whitelist',
  INPUT_FORMAT_WHITELIST,
  '-protocol_whitelist',
  INPUT_PROTOCOL_WHITELIST,
  '-max_pixels',
  String(maxPixels),
];

export const buildVideoFfprobeArguments = (
  inputPath: string,
  limits: Pick<VideoTranscodeLimits, 'maxPixels'>,
): string[] => [
  '-v',
  'error',
  ...buildVideoInputSafetyArguments(limits.maxPixels),
  '-show_entries',
  'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio:stream_side_data=rotation',
  '-of',
  'json',
  inputPath,
];

export const probeVideo = async ({
  ffprobePath = 'ffprobe',
  inputPath,
  limits,
  signal,
}: {
  ffprobePath?: string;
  inputPath: string;
  limits: Pick<
    VideoTranscodeLimits,
    | 'ffprobeTimeoutMs'
    | 'maxAspectRatio'
    | 'maxDurationSeconds'
    | 'maxFps'
    | 'maxHeight'
    | 'maxPixels'
    | 'maxWidth'
  >;
  signal: AbortSignal;
}): Promise<VideoProbe> => {
  let result: Awaited<ReturnType<typeof runVideoProcess>>;

  try {
    result = await runVideoProcess({
      command: ffprobePath,
      args: buildVideoFfprobeArguments(inputPath, limits),
      signal,
      timeoutMs: limits.ffprobeTimeoutMs,
    });
  } catch (error) {
    if (
      error instanceof VideoProcessExecutionError &&
      error.exitCode !== null &&
      error.terminationSignal === null
    ) {
      throw new InvalidVideoSourceError(`ffprobe rejected the video source: ${error.message}`, {
        cause: error,
      });
    }

    throw error;
  }

  return parseVideoProbeOutput(result.stdout, limits);
};

const evenWidthForHeight = (
  displayWidth: number,
  displayHeight: number,
  targetHeight: number,
): number => Math.max(2, Math.floor((displayWidth * targetHeight) / displayHeight / 2) * 2);

export const selectVideoTranscodeProfiles = ({
  displayHeight,
  displayWidth,
}: Pick<VideoProbe, 'displayHeight' | 'displayWidth'>): VideoArtifactProfile[] => {
  if (displayHeight < 240) {
    throw new VideoSourceResolutionTooLowError(displayHeight);
  }

  const selectedProfiles =
    displayHeight < 480
      ? TRANSCODE_PROFILES.slice(0, 1)
      : TRANSCODE_PROFILES.slice(1).filter((profile) => profile.height <= displayHeight);

  return selectedProfiles.map((profile) => ({
    ...profile,
    width: evenWidthForHeight(displayWidth, displayHeight, profile.height),
  }));
};

const localArtifactPath = (outputDirectory: string, relativePath: string): string =>
  resolve(outputDirectory, ...relativePath.split('/'));

const thumbnailDimensions = ({
  displayHeight,
  displayWidth,
}: Pick<VideoProbe, 'displayHeight' | 'displayWidth'>): {
  height: number;
  width: number;
} => {
  const targetWidth = Math.max(2, Math.floor(Math.min(displayWidth, 1280) / 2) * 2);

  return {
    width: targetWidth,
    height: Math.max(2, Math.floor((displayHeight * targetWidth) / displayWidth / 2) * 2),
  };
};

export const buildVideoFfmpegArguments = ({
  generateThumbnail = true,
  inputPath,
  limits,
  manifest,
  outputDirectory,
  probe,
  threads,
}: {
  generateThumbnail?: boolean;
  inputPath: string;
  limits: Pick<VideoTranscodeLimits, 'maxDurationSeconds' | 'maxFps' | 'maxPixels'>;
  manifest: VideoArtifactManifest;
  outputDirectory: string;
  probe: VideoProbe;
  threads: number;
}): string[] => {
  if (manifest.renditions.length === 0) {
    throw new Error('Video artifact manifest must include at least one rendition');
  }

  const inputLabels = manifest.renditions.map((_, index) => `[rendition${index}in]`);
  const splitOutputLabels = [...inputLabels, ...(generateThumbnail ? ['[thumbnailin]'] : [])];
  const filters = [
    splitOutputLabels.length === 1
      ? `[0:v:0]null${splitOutputLabels[0]}`
      : `[0:v:0]split=${splitOutputLabels.length}${splitOutputLabels.join('')}`,
    ...manifest.renditions.map(
      (rendition, index) =>
        `${inputLabels[index]}scale=w=${rendition.width}:h=${rendition.height}:flags=lanczos,setsar=1[${rendition.quality}]`,
    ),
  ];
  if (generateThumbnail) {
    const thumbnail = thumbnailDimensions(probe);
    filters.push(
      `[thumbnailin]thumbnail,scale=w=${thumbnail.width}:h=${thumbnail.height}:flags=lanczos,setsar=1[thumbnail]`,
    );
  }

  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...buildVideoInputSafetyArguments(limits.maxPixels),
    '-autorotate',
    '-i',
    inputPath,
    '-filter_threads',
    String(threads),
    '-filter_complex_threads',
    String(threads),
    '-filter_complex',
    filters.join(';'),
  ];

  for (const rendition of manifest.renditions) {
    const segmentPattern = localArtifactPath(
      outputDirectory,
      `${rendition.segmentRelativeDirectory}/segment-%05d.ts`,
    );
    const playlistPath = localArtifactPath(outputDirectory, rendition.playlistRelativePath);
    args.push(
      '-map',
      `[${rendition.quality}]`,
      ...(probe.hasAudio ? ['-map', '0:a:0?'] : ['-an']),
      '-c:v',
      'libx264',
      '-crf',
      '24',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-maxrate',
      String(rendition.videoBitrate),
      '-bufsize',
      String(rendition.videoBitrate * 2),
      '-fpsmax',
      String(limits.maxFps),
      '-threads',
      String(threads),
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION_SECONDS})`,
      ...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', String(AAC_AUDIO_BITRATE_BITS_PER_SECOND)] : []),
      '-t',
      String(limits.maxDurationSeconds),
      '-f',
      'hls',
      '-hls_time',
      String(HLS_SEGMENT_DURATION_SECONDS),
      '-hls_list_size',
      '0',
      '-hls_playlist_type',
      'vod',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_filename',
      segmentPattern,
      playlistPath,
    );
  }

  if (generateThumbnail) {
    args.push(
      '-map',
      '[thumbnail]',
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-threads',
      String(threads),
      '-compression_level',
      '6',
      localArtifactPath(outputDirectory, manifest.thumbnail.relativePath),
    );
  }

  return args;
};

const normalizeRenditionPlaylist = async (playlistPath: string): Promise<void> => {
  const contents = await readFile(playlistPath, 'utf8');
  const normalized = contents
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.trim();

      if (trimmed === '' || trimmed.startsWith('#')) {
        return line;
      }

      return `segments/${basename(trimmed.replaceAll('\\', '/'))}`;
    })
    .join('\n');

  await writeFile(playlistPath, normalized, 'utf8');
};

const hlsAdvertisedBandwidth = (videoBitrate: number, hasAudio: boolean): number =>
  Math.ceil(
    ((videoBitrate + (hasAudio ? AAC_AUDIO_BITRATE_BITS_PER_SECOND : 0)) *
      HLS_BANDWIDTH_SAFETY_PERCENT) /
      100,
  );

const createMasterPlaylist = (manifest: VideoArtifactManifest, hasAudio: boolean): string => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const rendition of manifest.renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${hlsAdvertisedBandwidth(rendition.videoBitrate, hasAudio)},RESOLUTION=${rendition.width}x${rendition.height}`,
      `${rendition.quality}/index.m3u8`,
    );
  }

  return `${lines.join('\n')}\n`;
};

const describeGeneratedFile = async ({
  contentType,
  objectKey,
  outputDirectory,
  relativePath,
}: {
  contentType: string;
  objectKey: string;
  outputDirectory: string;
  relativePath: string;
}): Promise<GeneratedVideoArtifact> => {
  const file = await stat(localArtifactPath(outputDirectory, relativePath));

  if (!file.isFile() || file.size <= 0 || !Number.isSafeInteger(file.size)) {
    throw new Error(`Generated artifact is empty or invalid: ${relativePath}`);
  }

  return {
    objectKey,
    filePath: localArtifactPath(outputDirectory, relativePath),
    contentType,
    sizeBytes: file.size,
  };
};

export const assertVideoArtifactSizeLimit = (
  artifacts: readonly Pick<GeneratedVideoArtifact, 'sizeBytes'>[],
  maxArtifactBytes: number,
): void => {
  let totalSizeBytes = 0;

  for (const artifact of artifacts) {
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
      throw new Error('Generated artifact has an invalid size');
    }

    if (artifact.sizeBytes > maxArtifactBytes - totalSizeBytes) {
      throw new VideoArtifactSizeExceededError(maxArtifactBytes);
    }

    totalSizeBytes += artifact.sizeBytes;
  }
};

export const isTerminalVideoTranscodeError = (error: unknown): boolean =>
  error instanceof InvalidVideoSourceError ||
  error instanceof VideoArtifactSizeExceededError ||
  error instanceof VideoProcessTimeoutError;

export const transcodeVideoArtifacts = async ({
  ffmpegPath = 'ffmpeg',
  inputPath,
  limits,
  manifest,
  outputDirectory,
  probe,
  signal,
  sourceThumbnailPath,
  threads,
}: {
  ffmpegPath?: string;
  inputPath: string;
  limits: Pick<
    VideoTranscodeLimits,
    'ffmpegTimeoutMs' | 'maxArtifactBytes' | 'maxDurationSeconds' | 'maxFps' | 'maxPixels'
  >;
  manifest: VideoArtifactManifest;
  outputDirectory: string;
  probe: VideoProbe;
  signal: AbortSignal;
  sourceThumbnailPath?: string;
  threads: number;
}): Promise<GeneratedVideoArtifacts> => {
  await Promise.all([
    mkdir(dirname(localArtifactPath(outputDirectory, manifest.thumbnail.relativePath)), {
      recursive: true,
    }),
    ...manifest.renditions.map((rendition) =>
      mkdir(localArtifactPath(outputDirectory, rendition.segmentRelativeDirectory), {
        recursive: true,
      }),
    ),
  ]);

  await runVideoProcess({
    command: ffmpegPath,
    args: buildVideoFfmpegArguments({
      generateThumbnail: !sourceThumbnailPath,
      inputPath,
      limits,
      manifest,
      outputDirectory,
      probe,
      threads,
    }),
    signal,
    timeoutMs: limits.ffmpegTimeoutMs,
  });

  if (sourceThumbnailPath) {
    await copyFile(
      sourceThumbnailPath,
      localArtifactPath(outputDirectory, manifest.thumbnail.relativePath),
    );
  }

  for (const rendition of manifest.renditions) {
    await normalizeRenditionPlaylist(
      localArtifactPath(outputDirectory, rendition.playlistRelativePath),
    );
  }
  await writeFile(
    localArtifactPath(outputDirectory, manifest.master.relativePath),
    createMasterPlaylist(manifest, probe.hasAudio),
    'utf8',
  );

  const master = await describeGeneratedFile({
    contentType: 'application/vnd.apple.mpegurl',
    objectKey: manifest.master.objectKey,
    outputDirectory,
    relativePath: manifest.master.relativePath,
  });
  const thumbnailArtifact = await describeGeneratedFile({
    contentType: 'image/webp',
    objectKey: manifest.thumbnail.objectKey,
    outputDirectory,
    relativePath: manifest.thumbnail.relativePath,
  });
  const playlistArtifacts: GeneratedVideoArtifact[] = [];
  const renditionSegments: GeneratedVideoArtifacts['renditionSegments'] = [];

  for (const rendition of manifest.renditions) {
    const playlist = await describeGeneratedFile({
      contentType: 'application/vnd.apple.mpegurl',
      objectKey: rendition.playlistObjectKey,
      outputDirectory,
      relativePath: rendition.playlistRelativePath,
    });
    const segmentDirectory = localArtifactPath(outputDirectory, rendition.segmentRelativeDirectory);
    const segmentNames = (await readdir(segmentDirectory))
      .filter((name) => VIDEO_HLS_SEGMENT_NAME_PATTERN.test(name))
      .sort();

    if (segmentNames.length === 0) {
      throw new Error(`FFmpeg generated no HLS segment for ${rendition.quality}`);
    }

    const segments = await Promise.all(
      segmentNames.map((name) =>
        describeGeneratedFile({
          contentType: 'video/mp2t',
          objectKey: videoHlsSegmentObjectKey(rendition, name),
          outputDirectory,
          relativePath: `${rendition.segmentRelativeDirectory}/${name}`,
        }),
      ),
    );
    playlistArtifacts.push(playlist);
    renditionSegments.push(segments);
  }

  const files = [master, thumbnailArtifact, ...playlistArtifacts, ...renditionSegments.flat()];
  assertVideoArtifactSizeLimit(files, limits.maxArtifactBytes);

  return {
    files,
    renditionSegments,
  };
};
