import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect } from 'vitest';

import sharp from '../../../src/lib/sharp.js';
import type { ObjectStorage } from '../../../src/lib/objectStorage.js';
import type { VideosPorts } from '../../../src/services/videos.types.js';
import type { TestRuntime } from './runtime.js';

const execFileAsync = promisify(execFile);

export const INITIAL_PASSWORD = 'Password1!';

export const createPng = async (width = 800, height = 600): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#3388ff',
    },
  })
    .png()
    .toBuffer();

export const createTranscodeTestVideo = async ({
  container = 'mp4',
  displayRotation = 0,
  durationSeconds = 1.5,
  frameRate = 24,
  height = 480,
  sampleAspectRatio = '1/1',
  visualPattern = 'testsrc',
  width = 640,
}: {
  container?: 'matroska' | 'mp4';
  displayRotation?: 0 | 90 | 180 | 270;
  durationSeconds?: number;
  frameRate?: number;
  height?: number;
  sampleAspectRatio?: string;
  visualPattern?: 'testsrc' | 'vertical-halves';
  width?: number;
} = {}): Promise<Buffer> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-video-'));
  const encodedPath = resolve(directory, 'encoded.mp4');
  const rotatedPath = resolve(directory, 'rotated.mp4');

  try {
    if (container !== 'mp4' && displayRotation !== 0) {
      throw new Error('Display rotation test fixtures require an MP4 container');
    }

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        visualPattern === 'vertical-halves'
          ? `color=c=red:size=${width}x${height}:rate=${frameRate},drawbox=x=iw/2:y=0:w=iw/2:h=ih:color=blue:t=fill,setsar=${sampleAspectRatio}`
          : `testsrc=size=${width}x${height}:rate=${frameRate},setsar=${sampleAspectRatio}`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=48000',
        '-t',
        String(durationSeconds),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
        '-c:a',
        'aac',
        '-shortest',
        ...(container === 'mp4' ? ['-movflags', '+faststart'] : ['-f', 'matroska']),
        encodedPath,
      ],
      { timeout: 30_000 },
    );

    if (displayRotation === 0) {
      return await readFile(encodedPath);
    }

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-display_rotation',
        String(displayRotation),
        '-i',
        encodedPath,
        '-map',
        '0',
        '-c',
        'copy',
        rotatedPath,
      ],
      { timeout: 30_000 },
    );

    return await readFile(rotatedPath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

type ProbedVideoArtifact = {
  durationSeconds: number;
  frameRate: number;
  height: number;
  sampleAspectRatio: string;
  width: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parsePositiveRational = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const [numeratorText, denominatorText, ...remainder] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);

  if (
    remainder.length > 0 ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }

  return numerator / denominator;
};

export const readStoredObject = async (
  storage: ObjectStorage,
  bucket: string,
  objectKey: string,
): Promise<string> => (await readStoredObjectBuffer(storage, bucket, objectKey)).toString('utf8');

export const readStoredObjectBuffer = async (
  storage: ObjectStorage,
  bucket: string,
  objectKey: string,
): Promise<Buffer> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-object-'));
  const destinationPath = resolve(directory, 'object');

  try {
    await storage.downloadObject({
      bucket,
      objectKey,
      destinationPath,
    });

    return await readFile(destinationPath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

export const probeVideoArtifact = async (body: Buffer): Promise<ProbedVideoArtifact> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-probe-'));
  const inputPath = resolve(directory, 'artifact.ts');

  try {
    await writeFile(inputPath, body);
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'format=duration:stream=avg_frame_rate,height,sample_aspect_ratio,width',
        '-of',
        'json',
        inputPath,
      ],
      { timeout: 30_000 },
    );

    const parsed: unknown = JSON.parse(stdout);

    if (!isRecord(parsed) || !Array.isArray(parsed.streams) || !isRecord(parsed.format)) {
      throw new Error('ffprobe returned incomplete artifact metadata');
    }

    const videoStream = parsed.streams.find(isRecord);
    const durationSeconds = Number(parsed.format.duration);
    const frameRate = videoStream ? parsePositiveRational(videoStream.avg_frame_rate) : null;
    const width = videoStream ? Number(videoStream.width) : Number.NaN;
    const height = videoStream ? Number(videoStream.height) : Number.NaN;
    const sampleAspectRatio = videoStream?.sample_aspect_ratio;

    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      frameRate === null ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      typeof sampleAspectRatio !== 'string'
    ) {
      throw new Error('ffprobe returned invalid artifact metadata');
    }

    return {
      durationSeconds,
      frameRate,
      height,
      sampleAspectRatio,
      width,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

export const decodeFirstVideoFrame = async (
  body: Buffer,
): Promise<{ channels: number; data: Buffer; height: number; width: number }> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-frame-'));
  const inputPath = resolve(directory, 'artifact.ts');
  const outputPath = resolve(directory, 'frame.png');

  try {
    await writeFile(inputPath, body);
    await execFileAsync(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-frames:v', '1', outputPath],
      { timeout: 30_000 },
    );
    const { data, info } = await sharp(await readFile(outputPath))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      channels: info.channels,
      data,
      height: info.height,
      width: info.width,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

export const createVerifiedSession = async (
  runtime: TestRuntime,
  {
    email,
    username,
  }: {
    email: string;
    username: string;
  },
): Promise<{ sessionKey: string; userId: string }> => {
  await runtime.authService.register({
    email,
    username,
    password: INITIAL_PASSWORD,
  });

  const verificationEmail = runtime.delivered.verification.at(-1);
  const result = await runtime.authService.verifyEmail({
    email,
    code: verificationEmail?.token ?? '',
  });

  return {
    sessionKey: result.sessionKey,
    userId: result.user.id,
  };
};

export const uploadVideoSource = async (
  service: VideosPorts,
  {
    body,
    userId,
    videoId,
    thumbnails = [],
  }: {
    body: Buffer;
    userId: string;
    videoId: string;
    thumbnails?: readonly Buffer[];
  },
) => {
  const initialized = await service.initMultipartUpload({
    userId,
    videoId,
    sizeBytes: body.length,
  });
  const uploadId = initialized.uploadSession.uploadId;

  if (!uploadId) {
    throw new Error('Initialized multipart upload did not expose its upload id');
  }

  for (const thumbnail of thumbnails) {
    await service.uploadSourceThumbnail({
      userId,
      videoId,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: thumbnail,
        size: thumbnail.length,
      },
    });
  }

  const signed = await service.signMultipartUploadParts({
    userId,
    videoId,
    uploadSessionId: initialized.uploadSession.id,
    partNumbers: [1],
  });
  const uploadResponse = await fetch(signed.parts[0]?.url ?? '', {
    method: 'PUT',
    body,
  });

  expect(uploadResponse.status).toBe(200);
  const etag = uploadResponse.headers.get('etag');

  if (!etag) {
    throw new Error('Multipart source upload did not return an ETag');
  }

  return service.completeMultipartUpload({
    userId,
    videoId,
    uploadSessionId: initialized.uploadSession.id,
    parts: [{ partNumber: 1, etag }],
  });
};
