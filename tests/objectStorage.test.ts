import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer, type Agent as HttpAgent } from 'node:http';
import { Readable } from 'node:stream';
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
  bucket: 'user-media',
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

  test('ensures the bucket once before writes and signs GET URLs with the public client', async () => {
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
    const signingClient = {
      presignedGetObject: async (bucket: string, objectKey: string, expires?: number) => {
        calls.push(['signer.presignedGetObject', bucket, objectKey, expires]);
        return `http://localhost:9000/${bucket}/${objectKey}?signature=test`;
      },
    };
    const storage = createObjectStorage(createConfig(), client, logger, signingClient);

    await storage.putObject({
      objectKey: 'users/user-id/avatar/current-avatar.webp',
      body: Buffer.from('avatar'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=900',
    });
    const signedUrl = await storage.getSignedUrl('users/user-id/avatar/current-avatar.webp');

    expect(signedUrl).toBe(
      'http://localhost:9000/user-media/users/user-id/avatar/current-avatar.webp?signature=test',
    );
    expect(calls).toEqual([
      ['bucketExists', 'user-media'],
      ['makeBucket', 'user-media', 'us-east-1'],
      [
        'putObject',
        'user-media',
        'users/user-id/avatar/current-avatar.webp',
        'avatar',
        6,
        {
          'Content-Type': 'image/webp',
          'Cache-Control': 'private, max-age=900',
        },
      ],
      ['signer.presignedGetObject', 'user-media', 'users/user-id/avatar/current-avatar.webp', 900],
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
        bucket: 'user-media',
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

  test('orchestrates multipart uploads with signed part URLs', async () => {
    const calls: unknown[] = [];
    const client = {
      bucketExists: async () => true,
      makeBucket: async () => undefined,
      putObject: async () => undefined,
      removeObject: async () => undefined,
      statObject: async () => undefined,
      presignedGetObject: async () => 'http://minio:9000/test',
      initiateNewMultipartUpload: async (
        bucket: string,
        objectKey: string,
        headers: Record<string, string>,
      ) => {
        calls.push(['initiateNewMultipartUpload', bucket, objectKey, headers]);

        return 'upload-id';
      },
      completeMultipartUpload: async (
        bucket: string,
        objectKey: string,
        uploadId: string,
        parts: { part: number; etag?: string }[],
      ) => {
        calls.push(['completeMultipartUpload', bucket, objectKey, uploadId, parts]);
      },
      abortMultipartUpload: async (bucket: string, objectKey: string, uploadId: string) => {
        calls.push(['abortMultipartUpload', bucket, objectKey, uploadId]);
      },
    };
    const signingClient = {
      presignedGetObject: async () => 'http://localhost:9000/test',
      presignedUrl: async (
        method: string,
        bucket: string,
        objectKey: string,
        expires?: number,
        reqParams?: Record<string, string>,
      ) => {
        calls.push(['presignedUrl', method, bucket, objectKey, expires, reqParams]);

        return `http://localhost:9000/${bucket}/${objectKey}?partNumber=${reqParams?.partNumber}&uploadId=${reqParams?.uploadId}`;
      },
    };
    const storage = createObjectStorage(
      createConfig({ bucket: 'videos' }),
      client,
      createOperationLogCollector().logger,
      signingClient,
    );

    await expect(
      storage.initiateMultipartUpload({
        objectKey: 'user-id/video-id/original.mp4',
        contentType: 'video/mp4',
      }),
    ).resolves.toEqual({ uploadId: 'upload-id' });
    await expect(
      storage.signMultipartUploadPart({
        objectKey: 'user-id/video-id/original.mp4',
        uploadId: 'upload-id',
        partNumber: 1,
      }),
    ).resolves.toBe(
      'http://localhost:9000/videos/user-id/video-id/original.mp4?partNumber=1&uploadId=upload-id',
    );
    await expect(
      storage.completeMultipartUpload({
        objectKey: 'user-id/video-id/original.mp4',
        uploadId: 'upload-id',
        parts: [
          {
            partNumber: 1,
            etag: '"etag-1"',
          },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(
      storage.abortMultipartUpload({
        objectKey: 'user-id/video-id/original.mp4',
        uploadId: 'upload-id',
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      [
        'initiateNewMultipartUpload',
        'videos',
        'user-id/video-id/original.mp4',
        { 'Content-Type': 'video/mp4' },
      ],
      [
        'presignedUrl',
        'PUT',
        'videos',
        'user-id/video-id/original.mp4',
        900,
        { partNumber: '1', uploadId: 'upload-id' },
      ],
      [
        'completeMultipartUpload',
        'videos',
        'user-id/video-id/original.mp4',
        'upload-id',
        [{ part: 1, etag: '"etag-1"' }],
      ],
      ['abortMultipartUpload', 'videos', 'user-id/video-id/original.mp4', 'upload-id'],
    ]);
  });

  test('downloads, heads, and lists only bounded resources in an explicit bucket', async () => {
    const calls: unknown[] = [];
    const client = {
      bucketExists: async (bucket: string) => {
        calls.push(['bucketExists', bucket]);
        return true;
      },
      makeBucket: async () => undefined,
      putObject: async () => undefined,
      removeObject: async () => undefined,
      statObject: async (bucket: string, objectKey: string) => {
        calls.push(['statObject', bucket, objectKey]);

        if (objectKey === 'missing') {
          const err = new Error('missing') as Error & { code: string };
          err.code = 'NoSuchKey';
          throw err;
        }

        return { size: 12 };
      },
      presignedGetObject: async () => 'http://minio:9000/test',
      fGetObject: async (bucket: string, objectKey: string, destinationPath: string) => {
        calls.push(['fGetObject', bucket, objectKey, destinationPath]);
      },
      getObject: async (bucket: string, objectKey: string) => {
        calls.push(['getObject', bucket, objectKey]);

        if (objectKey === 'missing') {
          const err = new Error('missing') as Error & { code: string };
          err.code = 'NoSuchKey';
          throw err;
        }

        return Readable.from([Buffer.from('bounded object')]);
      },
      listObjectsV2: (bucket: string, prefix: string, recursive: boolean) => {
        calls.push(['listObjectsV2', bucket, prefix, recursive]);

        return Readable.from([
          { name: `${prefix}a`, size: 1 },
          { name: `${prefix}b`, size: 2 },
          { name: `${prefix}c`, size: 3 },
        ]);
      },
      listIncompleteUploads: (bucket: string, prefix: string, recursive: boolean) => {
        calls.push(['listIncompleteUploads', bucket, prefix, recursive]);

        return Readable.from([
          { key: `${prefix}a`, uploadId: 'upload-a', size: 1 },
          { key: `${prefix}b`, uploadId: 'upload-b', size: 2 },
        ]);
      },
    };
    const storage = createObjectStorage(
      createConfig(),
      client,
      createOperationLogCollector().logger,
    );

    await expect(
      storage.downloadObject({
        bucket: 'videos',
        objectKey: 'source.mp4',
        destinationPath: 'C:\\tmp\\source.mp4',
      }),
    ).resolves.toBeUndefined();
    await expect(
      storage.readObject({
        bucket: 'videos',
        objectKey: 'playlist.m3u8',
        maxBytes: 128,
      }),
    ).resolves.toEqual(Buffer.from('bounded object'));
    await expect(
      storage.readObject({
        bucket: 'videos',
        objectKey: 'missing',
        maxBytes: 128,
      }),
    ).resolves.toBeNull();
    await expect(
      storage.readObject({
        bucket: 'videos',
        objectKey: 'playlist.m3u8',
        maxBytes: 4,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    await expect(
      storage.headObject({ bucket: 'videos', objectKey: 'source.mp4' }),
    ).resolves.toEqual({
      objectKey: 'source.mp4',
      sizeBytes: 12,
    });
    await expect(
      storage.headObject({ bucket: 'videos', objectKey: 'missing' }),
    ).resolves.toBeNull();
    await expect(
      storage.listObjects({ bucket: 'videos', prefix: 'generation/', limit: 2 }),
    ).resolves.toEqual({
      objects: [
        { objectKey: 'generation/a', sizeBytes: 1 },
        { objectKey: 'generation/b', sizeBytes: 2 },
      ],
      truncated: true,
    });
    await expect(
      storage.listMultipartUploads({ bucket: 'videos', prefix: 'source', limit: 1 }),
    ).resolves.toEqual({
      uploads: [{ objectKey: 'sourcea', uploadId: 'upload-a' }],
      truncated: true,
    });

    expect(calls).toContainEqual(['bucketExists', 'videos']);
    expect(calls).toContainEqual(['fGetObject', 'videos', 'source.mp4', 'C:\\tmp\\source.mp4']);
    expect(calls).toContainEqual(['getObject', 'videos', 'playlist.m3u8']);
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
        const err = new Error('missing') as Error & { code: string; statusCode: number };
        err.code = 'NoSuchKey';
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

  test('keeps an unrecognized proxy 404 retryable instead of treating it as absence', async () => {
    const client = {
      bucketExists: async () => true,
      makeBucket: async () => undefined,
      putObject: async () => undefined,
      removeObject: async () => undefined,
      statObject: async () => {
        const err = new Error('proxy route missing') as Error & {
          code: string;
          statusCode: number;
        };
        err.code = 'ProxyRouteNotFound';
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

    await expect(
      storage.headObject({
        bucket: 'videos',
        objectKey: 'source.mp4',
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
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
        bucket: 'user-media',
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        operation: 'objectStorage.putObject',
        outcome: 'failure',
        timeoutMs: 5_000,
      },
    });
    expect(logs.at(-1)?.data.err).toBeInstanceOf(Error);
  });

  test('times out slow storage client operations without aborting the shared client', async () => {
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
      expect(abortCalls).toBe(0);
    }
  });

  test('cancels only the timed-out request while a healthy request keeps using the same agent', async () => {
    let markPutStarted: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    let markPutCancelled: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const putCancelled = new Promise<void>((resolve) => {
      markPutCancelled = resolve;
    });
    const readCanFinish = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const server = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200).end();
        return;
      }

      if (request.method === 'PUT') {
        markPutStarted?.();
        const acknowledgeCancellation = (): void => {
          markPutCancelled?.();
          response.destroy();
        };
        request.once('aborted', acknowledgeCancellation);
        request.once('close', acknowledgeCancellation);
        return;
      }

      if (request.method === 'GET') {
        markReadStarted?.();
        void readCanFinish.then(() => {
          response.writeHead(200, { 'content-length': '6' }).end('avatar');
        });
        return;
      }

      response.writeHead(404).end();
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Expected the storage test server to listen on a TCP port');
    }

    const config = createConfig({
      endpoint: `http://127.0.0.1:${address.port}`,
      operationTimeoutMs: 300,
    });
    const minioClient = createMinioClient(config);
    const agent = (minioClient as unknown as { transportAgent: HttpAgent }).transportAgent;
    const storage = createObjectStorage(config, minioClient, createOperationLogCollector().logger);

    try {
      await storage.ensureBucket();
      const timedOutWrite = storage.putObject({
        objectKey: 'users/user-id/avatar/replacement.webp',
        body: Buffer.from('replacement'),
        contentType: 'image/webp',
      });
      await putStarted;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const healthyRead = storage.readObject({
        objectKey: 'users/user-id/avatar/current.webp',
        maxBytes: 64,
      });
      await readStarted;

      await expect(timedOutWrite).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
      releaseRead?.();
      await expect(healthyRead).resolves.toEqual(Buffer.from('avatar'));
      await putCancelled;
    } finally {
      releaseRead?.();
      agent.destroy();
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await serverClosed;
    }
  });

  test('retries bucket initialization after a timed-out attempt', async () => {
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
          return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50));
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

    expect(abortCalls).toBe(0);
    expect(bucketExistsCalls).toBe(2);
    expect(putObjectCalls).toBe(1);
  });
});
