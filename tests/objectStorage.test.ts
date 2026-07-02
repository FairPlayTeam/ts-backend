import { describe, expect, test } from 'bun:test';
import type { ObjectStorageConfig } from '../src/config/env.parsers.js';
import {
  ObjectStorageUnavailableError,
  createMinioClient,
  createObjectStorage,
} from '../src/lib/objectStorage.js';
import { OperationTimeoutError } from '../src/lib/operationMetrics.js';
import { createOperationLogCollector } from './support/logCollector.js';

const createConfig = (overrides: Partial<ObjectStorageConfig> = {}): ObjectStorageConfig => ({
  endpoint: 'http://minio:9000',
  publicUrl: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'fairplay-user-media',
  accessKey: 'fairplay',
  secretKey: 'fairplay-minio-secret',
  signedUrlTtlSeconds: 900,
  operationTimeoutMs: 5_000,
  ...overrides,
});

describe('object storage', () => {
  test('configures the MinIO transport agent with the object storage timeout', () => {
    const client = createMinioClient(
      createConfig({
        endpoint: 'https://s3.example.com',
        operationTimeoutMs: 2_500,
      }),
    ) as unknown as { transportAgent: { options: { timeout?: number } } };

    expect(client.transportAgent.options.timeout).toBe(2_500);
  });

  test('ensures the bucket once before writes and rewrites signed URLs to the public origin', async () => {
    const calls: unknown[] = [];
    const { logger, logs } = createOperationLogCollector();
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
    const storage = createObjectStorage(createConfig(), client, logger);

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
    expect(
      logs.map(({ level, data, message }) => ({ level, operation: data.operation, message })),
    ).toEqual([
      {
        level: 'info',
        operation: 'objectStorage.ensureBucket',
        message: 'Object storage operation completed',
      },
      {
        level: 'info',
        operation: 'objectStorage.putObject',
        message: 'Object storage operation completed',
      },
      {
        level: 'info',
        operation: 'objectStorage.getSignedUrl',
        message: 'Object storage operation completed',
      },
    ]);
    expect(logs[1]).toMatchObject({
      data: {
        bucket: 'fairplay-user-media',
        contentType: 'image/webp',
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        outcome: 'success',
        sizeBytes: 6,
        timeoutMs: 5_000,
      },
    });
    expect(JSON.stringify(logs)).not.toContain('fairplay-minio-secret');
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
    const storage = createObjectStorage(
      createConfig(),
      client,
      createOperationLogCollector().logger,
    );

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
    const storage = createObjectStorage(
      createConfig(),
      client,
      createOperationLogCollector().logger,
    );

    await expect(storage.checkReady()).resolves.toBeUndefined();
    expect(calls).toEqual(['bucketExists', ['statObject', '.readiness']]);
  });

  test('wraps runtime storage client failures as unavailable service errors', async () => {
    const { logger, logs } = createOperationLogCollector();
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
    const storage = createObjectStorage(createConfig(), client, logger);

    await expect(
      storage.putObject({
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        body: Buffer.from('avatar'),
        contentType: 'image/webp',
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    expect(logs.at(-1)).toMatchObject({
      level: 'warn',
      message: 'Object storage operation failed',
      data: {
        bucket: 'fairplay-user-media',
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        operation: 'objectStorage.putObject',
        outcome: 'failure',
        timeoutMs: 5_000,
      },
    });
    expect(logs.at(-1)?.data.err).toBeInstanceOf(Error);
  });

  test('times out slow storage client operations and keeps the timeout as the cause', async () => {
    let abortCalls = 0;
    const client = {
      abortActiveRequests: () => {
        abortCalls += 1;
      },
      bucketExists: async () => true,
      makeBucket: async () => undefined,
      putObject: () => new Promise((resolve) => setTimeout(resolve, 50)),
      removeObject: async () => undefined,
      statObject: async () => undefined,
      presignedGetObject: async () => 'http://minio:9000/test',
    };
    const storage = createObjectStorage(
      createConfig({ operationTimeoutMs: 1 }),
      client,
      createOperationLogCollector().logger,
    );

    try {
      await storage.putObject({
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        body: Buffer.from('avatar'),
        contentType: 'image/webp',
      });
      throw new Error('Expected putObject to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ObjectStorageUnavailableError);
      expect((err as Error).cause).toBeInstanceOf(OperationTimeoutError);
      expect(abortCalls).toBe(1);
    }
  });

  test('retries bucket initialization after an aborted timeout', async () => {
    let abortCalls = 0;
    let bucketExistsCalls = 0;
    let putObjectCalls = 0;
    const client = {
      abortActiveRequests: () => {
        abortCalls += 1;
      },
      bucketExists: () => {
        bucketExistsCalls += 1;

        if (bucketExistsCalls === 1) {
          return new Promise<boolean>(() => undefined);
        }

        return Promise.resolve(true);
      },
      makeBucket: async () => undefined,
      putObject: async () => {
        putObjectCalls += 1;
      },
      removeObject: async () => undefined,
      statObject: async () => undefined,
      presignedGetObject: async () => 'http://minio:9000/test',
    };
    const storage = createObjectStorage(
      createConfig({ operationTimeoutMs: 1 }),
      client,
      createOperationLogCollector().logger,
    );

    await expect(
      storage.putObject({
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        body: Buffer.from('avatar'),
        contentType: 'image/webp',
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);

    await expect(
      storage.putObject({
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        body: Buffer.from('avatar'),
        contentType: 'image/webp',
      }),
    ).resolves.toBeUndefined();

    expect(abortCalls).toBe(1);
    expect(bucketExistsCalls).toBe(2);
    expect(putObjectCalls).toBe(1);
  });
});
