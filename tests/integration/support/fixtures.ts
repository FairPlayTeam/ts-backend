import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  height = 480,
  width = 640,
}: {
  height?: number;
  width?: number;
} = {}): Promise<Buffer> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-video-'));
  const outputPath = resolve(directory, 'source.mp4');

  try {
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
        `testsrc=size=${width}x${height}:rate=24`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=48000',
        '-t',
        '1.5',
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
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { timeout: 30_000 },
    );

    return await readFile(outputPath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
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
