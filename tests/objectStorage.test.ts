import { describe, expect, test } from 'bun:test';
import type { ObjectStorageConfig } from '../src/config/env.parsers.js';
import { ObjectStorageUnavailableError, createObjectStorage } from '../src/lib/objectStorage.js';

const createConfig = (overrides: Partial<ObjectStorageConfig> = {}): ObjectStorageConfig => ({
  endpoint: 'http://minio:9000',
  publicUrl: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'fairplay-user-media',
  accessKey: 'fairplay',
  secretKey: 'fairplay-minio-secret',
  signedUrlTtlSeconds: 900,
  ...overrides,
});

describe('object storage', () => {
  test('ensures the bucket once before writes and rewrites signed URLs to the public origin', async () => {
    const calls: unknown[] = [];
    const client = {
      bucketExists: async (bucket: string) => {
        calls.push(['bucketExists', bucket]);
        return false;
      },
      makeBucket: async (bucket: string, region?: string) => {
        calls.push(['makeBucket', bucket, region]);
      },
      putObject: async (
        bucket: string,
        objectKey: string,
        body: Buffer,
        size?: number,
        metadata?: Record<string, string>,
      ) => {
        calls.push(['putObject', bucket, objectKey, body.toString('utf8'), size, metadata]);
      },
      removeObject: async (bucket: string, objectKey: string) => {
        calls.push(['removeObject', bucket, objectKey]);
      },
      statObject: async (bucket: string, objectKey: string) => {
        calls.push(['statObject', bucket, objectKey]);
      },
      presignedGetObject: async (bucket: string, objectKey: string, expires?: number) => {
        calls.push(['presignedGetObject', bucket, objectKey, expires]);
        return `http://minio:9000/${bucket}/${objectKey}?signature=test`;
      },
    };
    const storage = createObjectStorage(createConfig(), client, { warn: () => undefined });

    await storage.putObject({
      objectKey: 'users/user-id/avatar/current-avatar.webp',
      body: Buffer.from('avatar'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=900',
    });
    const signedUrl = await storage.getSignedUrl('users/user-id/avatar/current-avatar.webp');

    expect(signedUrl).toBe(
      'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp?signature=test',
    );
    expect(calls).toEqual([
      ['bucketExists', 'fairplay-user-media'],
      ['makeBucket', 'fairplay-user-media', 'us-east-1'],
      [
        'putObject',
        'fairplay-user-media',
        'users/user-id/avatar/current-avatar.webp',
        'avatar',
        6,
        {
          'Content-Type': 'image/webp',
          'Cache-Control': 'private, max-age=900',
        },
      ],
      [
        'presignedGetObject',
        'fairplay-user-media',
        'users/user-id/avatar/current-avatar.webp',
        900,
      ],
    ]);
  });

  test('treats missing objects as already deleted', async () => {
    const client = {
      bucketExists: async () => true,
      makeBucket: async () => undefined,
      putObject: async () => undefined,
      removeObject: async () => {
        const err = new Error('missing') as Error & { code: string };
        err.code = 'NoSuchKey';
        throw err;
      },
      statObject: async () => undefined,
      presignedGetObject: async () => 'http://minio:9000/test',
    };
    const storage = createObjectStorage(createConfig(), client, { warn: () => undefined });

    await expect(
      storage.deleteObject('users/user-id/avatar/current-avatar.webp'),
    ).resolves.toBeUndefined();
  });

  test('readiness accepts a missing sentinel object after bucket creation succeeds', async () => {
    const calls: unknown[] = [];
    const client = {
      bucketExists: async () => {
        calls.push('bucketExists');
        return true;
      },
      makeBucket: async () => undefined,
      putObject: async () => undefined,
      removeObject: async () => undefined,
      statObject: async (_bucket: string, objectKey: string) => {
        calls.push(['statObject', objectKey]);
        const err = new Error('missing') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      },
      presignedGetObject: async () => 'http://minio:9000/test',
    };
    const storage = createObjectStorage(createConfig(), client, { warn: () => undefined });

    await expect(storage.checkReady()).resolves.toBeUndefined();
    expect(calls).toEqual(['bucketExists', ['statObject', '.readiness']]);
  });

  test('wraps runtime storage client failures as unavailable service errors', async () => {
    const client = {
      bucketExists: async () => true,
      makeBucket: async () => undefined,
      putObject: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      removeObject: async () => undefined,
      statObject: async () => undefined,
      presignedGetObject: async () => 'http://minio:9000/test',
    };
    const storage = createObjectStorage(createConfig(), client, { warn: () => undefined });

    await expect(
      storage.putObject({
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        body: Buffer.from('avatar'),
        contentType: 'image/webp',
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
  });
});
