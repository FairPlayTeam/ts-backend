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
const HLS_SEGMENT_DURATION_SECONDS = 6;

const TRANSCODE_PROFILES = [
  { quality: '480p', height: 480, bandwidth: 1_400_000 },
  { quality: '720p', height: 720, bandwidth: 2_800_000 },
  { quality: '1080p', height: 1080, bandwidth: 5_000_000 },
] as const;

export type VideoProbe = {
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
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

class VideoProcessExecutionError extends Error {
  constructor(command: string, exitCode: number | null, stderr: string) {
    const detail = stderr.trim();
    super(
      `${command} exited with code ${exitCode === null ? 'unknown' : String(exitCode)}${
        detail ? `: ${detail}` : ''
      }`,
    );
    this.name = 'VideoProcessExecutionError';
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

const toBoundedOutput = (current: Buffer, chunk: Buffer): Buffer => {
  const combined = Buffer.concat([current, chunk]);

  return combined.length <= PROCESS_OUTPUT_LIMIT_BYTES
    ? combined
    : combined.subarray(combined.length - PROCESS_OUTPUT_LIMIT_BYTES);
};

const runProcess = async ({
  args,
  command,
  cwd,
  signal,
}: {
  args: readonly string[];
  command: string;
  cwd?: string;
  signal: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolvePromise, rejectPromise) => {
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
    let aborted = false;

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
    };
    const abortProcess = (): void => {
      if (aborted) {
        return;
      }

      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, PROCESS_ABORT_KILL_DELAY_MS);
      killTimer.unref?.();
    };

    child.once('error', (error) => {
      cleanup();
      rejectPromise(error);
    });
    child.once('close', (exitCode) => {
      cleanup();

      if (aborted || signal.aborted) {
        const reason: unknown = signal.reason;
        rejectPromise(
          new VideoTranscodeAbortedError(reason instanceof Error ? { cause: reason } : {}),
        );
        return;
      }

      const stdoutText = stdout.toString('utf8');
      const stderrText = stderr.toString('utf8');

      if (exitCode !== 0) {
        rejectPromise(new VideoProcessExecutionError(command, exitCode, stderrText));
        return;
      }

      resolvePromise({ stdout: stdoutText, stderr: stderrText });
    });
    signal.addEventListener('abort', abortProcess, { once: true });

    if (signal.aborted) {
      abortProcess();
    }
  });

export const parseVideoProbeOutput = (output: string): VideoProbe => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error('ffprobe returned invalid JSON', { cause: error });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.streams) || !isRecord(parsed.format)) {
    throw new Error('ffprobe returned incomplete media metadata');
  }

  const streams = parsed.streams.filter(isRecord);
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const width = videoStream ? toFiniteNumber(videoStream.width) : null;
  const height = videoStream ? toFiniteNumber(videoStream.height) : null;
  const durationSeconds = toFiniteNumber(parsed.format.duration);

  if (
    width === null ||
    height === null ||
    durationSeconds === null ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 2 ||
    height < 2 ||
    durationSeconds <= 0 ||
    durationSeconds > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('ffprobe returned invalid video dimensions or duration');
  }

  return {
    width,
    height,
    durationSeconds,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  };
};

export const probeVideo = async ({
  ffprobePath = 'ffprobe',
  inputPath,
  signal,
}: {
  ffprobePath?: string;
  inputPath: string;
  signal: AbortSignal;
}): Promise<VideoProbe> => {
  const result = await runProcess({
    command: ffprobePath,
    args: [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,width,height',
      '-of',
      'json',
      inputPath,
    ],
    signal,
  });

  return parseVideoProbeOutput(result.stdout);
};

const evenWidthForHeight = (
  sourceWidth: number,
  sourceHeight: number,
  targetHeight: number,
): number => Math.max(2, Math.floor((sourceWidth * targetHeight) / sourceHeight / 2) * 2);

export const selectVideoTranscodeProfiles = ({
  height,
  width,
}: Pick<VideoProbe, 'height' | 'width'>): VideoArtifactProfile[] =>
  TRANSCODE_PROFILES.filter((profile) => profile.height <= height).map((profile) => ({
    ...profile,
    width: evenWidthForHeight(width, height, profile.height),
  }));

const localArtifactPath = (outputDirectory: string, relativePath: string): string =>
  resolve(outputDirectory, ...relativePath.split('/'));

const thumbnailDimensions = ({
  height,
  width,
}: Pick<VideoProbe, 'height' | 'width'>): {
  height: number;
  width: number;
} => {
  const targetWidth = Math.max(2, Math.floor(Math.min(width, 1280) / 2) * 2);

  return {
    width: targetWidth,
    height: Math.max(2, Math.floor((height * targetWidth) / width / 2) * 2),
  };
};

export const buildVideoFfmpegArguments = ({
  generateThumbnail = true,
  inputPath,
  manifest,
  outputDirectory,
  probe,
  threads,
}: {
  generateThumbnail?: boolean;
  inputPath: string;
  manifest: VideoArtifactManifest;
  outputDirectory: string;
  probe: VideoProbe;
  threads: number;
}): string[] => {
  if (manifest.renditions.length === 0) {
    throw new Error('Source video is smaller than every supported rendition');
  }

  const inputLabels = manifest.renditions.map((_, index) => `[rendition${index}in]`);
  const splitOutputLabels = [...inputLabels, ...(generateThumbnail ? ['[thumbnailin]'] : [])];
  const filters = [
    splitOutputLabels.length === 1
      ? `[0:v:0]null${splitOutputLabels[0]}`
      : `[0:v:0]split=${splitOutputLabels.length}${splitOutputLabels.join('')}`,
    ...manifest.renditions.map(
      (rendition, index) =>
        `${inputLabels[index]}scale=w=${rendition.width}:h=${rendition.height}:flags=lanczos[${rendition.quality}]`,
    ),
  ];
  if (generateThumbnail) {
    const thumbnail = thumbnailDimensions(probe);
    filters.push(
      `[thumbnailin]thumbnail,scale=w=${thumbnail.width}:h=${thumbnail.height}:flags=lanczos[thumbnail]`,
    );
  }

  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
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
      '-threads',
      String(threads),
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION_SECONDS})`,
      ...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
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

const createMasterPlaylist = (manifest: VideoArtifactManifest): string => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const rendition of manifest.renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},RESOLUTION=${rendition.width}x${rendition.height}`,
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

export const transcodeVideoArtifacts = async ({
  ffmpegPath = 'ffmpeg',
  inputPath,
  manifest,
  outputDirectory,
  probe,
  signal,
  sourceThumbnailPath,
  threads,
}: {
  ffmpegPath?: string;
  inputPath: string;
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

  await runProcess({
    command: ffmpegPath,
    args: buildVideoFfmpegArguments({
      generateThumbnail: !sourceThumbnailPath,
      inputPath,
      manifest,
      outputDirectory,
      probe,
      threads,
    }),
    signal,
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
    createMasterPlaylist(manifest),
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

  return {
    files: [master, thumbnailArtifact, ...playlistArtifacts, ...renditionSegments.flat()],
    renditionSegments,
  };
};
