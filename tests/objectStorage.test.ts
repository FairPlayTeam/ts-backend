import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import type { ObjectStorageConfig } from '../src/config/env.schema.js';
import {
  ObjectStorageUnavailableError,
  MultipartCompletionRejectedError,
  createS3ObjectStorageClient,
  createS3SigningClient,
  createObjectStorage,
} from '../src/lib/objectStorage.js';
import { OperationTimeoutError } from '../src/lib/operationMetrics.js';
import { createOperationLogCollector } from './support/logCollector.js';

const createConfig = (overrides: Partial<ObjectStorageConfig> = {}): ObjectStorageConfig => ({
  endpoint: 'http://object-storage:9000',
  publicUrl: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'user-media',
  accessKey: 'fairplay',
  secretKey: 'fairplay-object-storage-secret',
  signedUrlTtlSeconds: 900,
  operationTimeoutMs: 5_000,
  ...overrides,
});

describe('object storage', () => {
  test('signs path-style URLs against the configured public S3 endpoint', async () => {
    const signer = createS3SigningClient(
      createConfig({
        publicUrl: 'https://s3.example.com',
      }),
    );

    try {
      const signedUrl = await signer.signGetObjectUrl('user-media', 'users/user/avatar.webp', 120);
      const url = new URL(signedUrl);

      expect(url.origin).toBe('https://s3.example.com');
      expect(url.pathname).toBe('/user-media/users/user/avatar.webp');
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    } finally {
      signer.destroy();
    }
  });

  test('ensures the bucket once before writes and signs GET URLs with the public client', async () => {
    const calls: unknown[] = [];
    const { logger, logs } = createOperationLogCollector();
    const client = {
      bucketExists: async (bucket: string) => {
        calls.push(['bucketExists', bucket]);
        return false;
      },
      createBucket: async (bucket: string) => {
        calls.push(['createBucket', bucket]);
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
      deleteObject: async (bucket: string, objectKey: string) => {
        calls.push(['deleteObject', bucket, objectKey]);
      },
      headObject: async (bucket: string, objectKey: string) => {
        calls.push(['headObject', bucket, objectKey]);
      },
      signGetObjectUrl: async (bucket: string, objectKey: string, expires: number) => {
        calls.push(['signGetObjectUrl', bucket, objectKey, expires]);
        return `http://object-storage:9000/${bucket}/${objectKey}?signature=test`;
      },
    };
    const signingClient = {
      signGetObjectUrl: async (bucket: string, objectKey: string, expires: number) => {
        calls.push(['signer.signGetObjectUrl', bucket, objectKey, expires]);
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
      ['createBucket', 'user-media'],
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
      ['signer.signGetObjectUrl', 'user-media', 'users/user-id/avatar/current-avatar.webp', 900],
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
    expect(JSON.stringify(logs)).not.toContain('fairplay-object-storage-secret');
  });

  test('treats missing objects as already deleted', async () => {
    const client = {
      bucketExists: async () => true,
      createBucket: async () => undefined,
      putObject: async () => undefined,
      deleteObject: async () => {
        const err = new Error('missing') as Error & { code: string };
        err.code = 'NoSuchKey';
        throw err;
      },
      headObject: async () => undefined,
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
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

  for (const { name, message, terminal } of [
    { name: 'InvalidPart', message: 'A part does not exist', terminal: true },
    { name: 'InvalidPartOrder', message: 'Parts are out of order', terminal: true },
    { name: 'EntityTooSmall', message: 'A nonfinal part is too small', terminal: true },
    { name: 'NoSuchUpload', message: 'The upload does not exist', terminal: true },
    { name: 'MalformedXML', message: 'The completion XML cannot be parsed', terminal: true },
    { name: 'InvalidRequest', message: 'Bad request: No data was uploaded', terminal: true },
    { name: 'InvalidRequest', message: 'Unsupported storage configuration', terminal: false },
    { name: 'AccessDenied', message: 'Access denied', terminal: false },
    { name: 'InternalError', message: 'Storage unavailable', terminal: false },
    { name: 'Error', message: 'Bad request: No data was uploaded', terminal: false },
  ]) {
    test(`classifies multipart ${name}: ${message}`, async () => {
      const rejection = Object.assign(new Error(message), { name });
      const storage = createObjectStorage(
        createConfig(),
        {
          bucketExists: async () => true,
          createBucket: async () => undefined,
          putObject: async () => undefined,
          deleteObject: async () => undefined,
          headObject: async () => {
            throw rejection;
          },
          completeMultipartUpload: async () => {
            throw rejection;
          },
        },
        createOperationLogCollector().logger,
      );
      const outcome = await storage
        .completeMultipartUpload({
          objectKey: 'source.mp4',
          uploadId: 'upload',
          parts: [{ partNumber: 1, etag: 'etag' }],
        })
        .catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(
        terminal ? MultipartCompletionRejectedError : ObjectStorageUnavailableError,
      );
      expect(outcome).toMatchObject({ cause: rejection });
      if (terminal) expect(outcome).toMatchObject({ code: name });
      if (name === 'NoSuchUpload') {
        await expect(storage.headObject({ objectKey: 'source.mp4' })).resolves.toBeNull();
      } else {
        await expect(storage.headObject({ objectKey: 'source.mp4' })).rejects.toBeInstanceOf(
          ObjectStorageUnavailableError,
        );
      }
    });
  }

  test('orchestrates multipart uploads with signed part URLs', async () => {
    const calls: unknown[] = [];
    const client = {
      bucketExists: async () => true,
      createBucket: async () => undefined,
      putObject: async () => undefined,
      deleteObject: async () => undefined,
      headObject: async () => undefined,
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
      initiateMultipartUpload: async (
        bucket: string,
        objectKey: string,
        headers: Record<string, string>,
      ) => {
        calls.push(['initiateMultipartUpload', bucket, objectKey, headers]);

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
      signGetObjectUrl: async () => 'http://localhost:9000/test',
      signMultipartUploadPartUrl: async (
        bucket: string,
        objectKey: string,
        uploadId: string,
        partNumber: number,
        expires: number,
      ) => {
        calls.push([
          'signMultipartUploadPartUrl',
          bucket,
          objectKey,
          uploadId,
          partNumber,
          expires,
        ]);

        return `http://localhost:9000/${bucket}/${objectKey}?partNumber=${partNumber}&uploadId=${uploadId}`;
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
        'initiateMultipartUpload',
        'videos',
        'user-id/video-id/original.mp4',
        { 'Content-Type': 'video/mp4' },
      ],
      [
        'signMultipartUploadPartUrl',
        'videos',
        'user-id/video-id/original.mp4',
        'upload-id',
        1,
        900,
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
      createBucket: async () => undefined,
      putObject: async () => undefined,
      deleteObject: async () => undefined,
      headObject: async (bucket: string, objectKey: string) => {
        calls.push(['headObject', bucket, objectKey]);

        if (objectKey === 'missing') {
          const err = new Error('missing') as Error & { code: string };
          err.code = 'NoSuchKey';
          throw err;
        }

        return { size: 12 };
      },
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
      downloadObject: async (bucket: string, objectKey: string, destinationPath: string) => {
        calls.push(['downloadObject', bucket, objectKey, destinationPath]);
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
      listObjects: (bucket: string, prefix: string) => {
        calls.push(['listObjects', bucket, prefix]);

        return Readable.from([
          { name: `${prefix}a`, size: 1 },
          { name: `${prefix}b`, size: 2 },
          { name: `${prefix}c`, size: 3 },
        ]);
      },
      listMultipartUploads: (bucket: string, prefix: string) => {
        calls.push(['listMultipartUploads', bucket, prefix]);

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
    expect(calls).toContainEqual(['downloadObject', 'videos', 'source.mp4', 'C:\\tmp\\source.mp4']);
    expect(calls).toContainEqual(['getObject', 'videos', 'playlist.m3u8']);
  });

  for (const missingMarker of ['key', 'upload ID'] as const) {
    test(`rejects a truncated multipart page without its ${missingMarker} marker`, async () => {
      const listingRequests: string[] = [];
      const nextKeyMarker =
        missingMarker === 'key' ? '' : '<NextKeyMarker>same-key.bin</NextKeyMarker>';
      const nextUploadIdMarker =
        missingMarker === 'upload ID' ? '' : '<NextUploadIdMarker>upload-1</NextUploadIdMarker>';
      const missingMarkerMessage =
        missingMarker === 'key'
          ? 'Object storage returned a truncated multipart page without a key marker'
          : 'Object storage returned a truncated multipart page without an upload ID marker';
      const server = createServer((request, response) => {
        if (request.method === 'HEAD') {
          response.writeHead(200).end();
          return;
        }

        if (request.method === 'GET') {
          listingRequests.push(request.url ?? '');
          response
            .writeHead(200, { 'content-type': 'application/xml' })
            .end(
              `<?xml version="1.0" encoding="UTF-8"?>` +
                `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
                `<IsTruncated>true</IsTruncated>${nextKeyMarker}${nextUploadIdMarker}` +
                `<Upload><Key>same-key.bin</Key><UploadId>upload-1</UploadId></Upload>` +
                `</ListMultipartUploadsResult>`,
            );
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

      const config = createConfig({ endpoint: `http://127.0.0.1:${address.port}` });
      const storageClient = createS3ObjectStorageClient(config);
      const storage = createObjectStorage(
        config,
        storageClient,
        createOperationLogCollector().logger,
      );

      try {
        await expect(
          storage.listMultipartUploads({ prefix: 'same-key', limit: 10 }),
        ).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: missingMarkerMessage,
          }),
        });
        expect(listingRequests).toHaveLength(1);
      } finally {
        storageClient.destroy();
        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await serverClosed;
      }
    });
  }

  test('readiness accepts a missing sentinel object after bucket creation succeeds', async () => {
    const calls: unknown[] = [];
    const client = {
      bucketExists: async () => {
        calls.push('bucketExists');
        return true;
      },
      createBucket: async () => undefined,
      putObject: async () => undefined,
      deleteObject: async () => undefined,
      headObject: async (_bucket: string, objectKey: string) => {
        calls.push(['headObject', objectKey]);
        const err = new Error('missing') as Error & { code: string; statusCode: number };
        err.code = 'NoSuchKey';
        err.statusCode = 404;
        throw err;
      },
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
    };
    const storage = createObjectStorage(
      createConfig(),
      client,
      createOperationLogCollector().logger,
    );

    await expect(storage.checkReady()).resolves.toBeUndefined();
    expect(calls).toEqual(['bucketExists', ['headObject', '.readiness']]);
  });

  test('keeps an unrecognized proxy 404 retryable instead of treating it as absence', async () => {
    const client = {
      bucketExists: async () => true,
      createBucket: async () => undefined,
      putObject: async () => undefined,
      deleteObject: async () => undefined,
      headObject: async () => {
        const err = new Error('proxy route missing') as Error & {
          code: string;
          statusCode: number;
        };
        err.code = 'ProxyRouteNotFound';
        err.statusCode = 404;
        throw err;
      },
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
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
      createBucket: async () => undefined,
      putObject: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      deleteObject: async () => undefined,
      headObject: async () => undefined,
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
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

  test('times out slow fake storage operations and preserves the timeout cause', async () => {
    const client = {
      bucketExists: async () => true,
      createBucket: async () => undefined,
      putObject: () => new Promise((resolve) => setTimeout(resolve, 50)),
      deleteObject: async () => undefined,
      headObject: async () => undefined,
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
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
    }
  });

  test('cancels only the timed-out S3 request while a concurrent read remains healthy', async () => {
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
        request.once('aborted', () => markPutCancelled?.());
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
    const storageClient = createS3ObjectStorageClient(config);
    const storage = createObjectStorage(
      config,
      storageClient,
      createOperationLogCollector().logger,
    );

    try {
      await storage.ensureBucket();
      const timedOutWrite = storage.putObject({
        objectKey: 'users/user-id/avatar/replacement.webp',
        body: Buffer.alloc(32 * 1024 * 1024),
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
      storageClient.destroy();
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await serverClosed;
    }
  });

  test('retries bucket initialization after a timed-out attempt', async () => {
    let bucketExistsCalls = 0;
    let putObjectCalls = 0;
    const client = {
      bucketExists: () => {
        bucketExistsCalls += 1;

        if (bucketExistsCalls === 1) {
          return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50));
        }

        return Promise.resolve(true);
      },
      createBucket: async () => undefined,
      putObject: async () => {
        putObjectCalls += 1;
      },
      deleteObject: async () => undefined,
      headObject: async () => undefined,
      signGetObjectUrl: async () => 'http://object-storage:9000/test',
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

    expect(bucketExistsCalls).toBe(2);
    expect(putObjectCalls).toBe(1);
  });
});
