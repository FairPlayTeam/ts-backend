import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Client } from 'minio';
import type { ObjectStorageConfig } from '../config/env.parsers.js';
import { observeOperation, type OperationLogger } from './operationMetrics.js';

type ObjectStorageClient = {
  abortActiveRequests?(): void;
  bucketExists(bucketName: string): Promise<boolean>;
  makeBucket(bucketName: string, region?: string): Promise<void>;
  putObject(
    bucketName: string,
    objectName: string,
    stream: Buffer,
    size?: number,
    metaData?: Record<string, string>,
  ): Promise<unknown>;
  removeObject(bucketName: string, objectName: string): Promise<void>;
  statObject(bucketName: string, objectName: string): Promise<unknown>;
  presignedGetObject(bucketName: string, objectName: string, expires?: number): Promise<string>;
};

export type ObjectStorage = {
  bucket: string;
  ensureBucket(): Promise<void>;
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(objectKey: string): Promise<void>;
  deleteObjects(objectKeys: readonly string[]): Promise<void>;
  getSignedUrl(objectKey: string): Promise<string>;
  checkReady(): Promise<void>;
};

type PutObjectInput = {
  objectKey: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
};

export class ObjectStorageUnavailableError extends Error {
  constructor(
    message = 'Object storage is not configured or unavailable',
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'ObjectStorageUnavailableError';
  }
}

const rejectUnavailableObjectStorage = <T = never>(): Promise<T> =>
  Promise.reject(new ObjectStorageUnavailableError());

const toObjectStorageUnavailableError = (err: unknown): ObjectStorageUnavailableError =>
  err instanceof ObjectStorageUnavailableError
    ? err
    : new ObjectStorageUnavailableError(undefined, { cause: err });

const runObjectStorageOperation = async <T>({
  config,
  data = {},
  logger,
  onAbort,
  operation,
  run,
}: {
  config: ObjectStorageConfig;
  data?: Record<string, unknown>;
  logger: OperationLogger;
  operation: string;
  onAbort?: () => void;
  run: () => Promise<T>;
}): Promise<T> => {
  try {
    return await observeOperation({
      operation,
      timeoutMs: config.operationTimeoutMs,
      logger,
      data: {
        bucket: config.bucket,
        ...data,
      },
      ...(onAbort ? { onAbort } : {}),
      successMessage: 'Object storage operation completed',
      failureMessage: 'Object storage operation failed',
      run,
    });
  } catch (err) {
    throw toObjectStorageUnavailableError(err);
  }
};

export const createUnavailableObjectStorage = (): ObjectStorage => ({
  bucket: '',
  ensureBucket: () => rejectUnavailableObjectStorage<void>(),
  putObject: () => rejectUnavailableObjectStorage<void>(),
  deleteObject: () => rejectUnavailableObjectStorage<void>(),
  deleteObjects: () => rejectUnavailableObjectStorage<void>(),
  getSignedUrl: () => rejectUnavailableObjectStorage<string>(),
  checkReady: () => rejectUnavailableObjectStorage<void>(),
});

const isNotFoundStorageError = (err: unknown): boolean => {
  if (!(err instanceof Error)) {
    return false;
  }

  const error = err as Error & {
    code?: unknown;
    statusCode?: unknown;
  };

  return error.code === 'NoSuchKey' || error.code === 'NotFound' || error.statusCode === 404;
};

const rewriteSignedUrlOrigin = (signedUrl: string, publicUrl: string): string => {
  const url = new URL(signedUrl);
  const publicOrigin = new URL(publicUrl);

  url.protocol = publicOrigin.protocol;
  url.hostname = publicOrigin.hostname;
  url.port = publicOrigin.port;

  return url.toString();
};

export const createMinioClient = (config: ObjectStorageConfig): Client => {
  const endpoint = new URL(config.endpoint);
  const transportAgent =
    endpoint.protocol === 'https:'
      ? new HttpsAgent({ timeout: config.operationTimeoutMs })
      : new HttpAgent({ timeout: config.operationTimeoutMs });

  const client = new Client({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    useSSL: endpoint.protocol === 'https:',
    pathStyle: true,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    transportAgent,
  });

  return Object.assign(client, {
    abortActiveRequests: () => {
      transportAgent.destroy();
    },
  });
};

export const createObjectStorage = (
  config: ObjectStorageConfig,
  client: ObjectStorageClient,
  logger: OperationLogger,
): ObjectStorage => {
  let bucketReady: Promise<void> | null = null;
  const abortActiveRequests = client.abortActiveRequests
    ? (): void => client.abortActiveRequests?.()
    : undefined;

  const ensureBucket = async (): Promise<void> => {
    bucketReady ??= runObjectStorageOperation({
      config,
      logger,
      operation: 'objectStorage.ensureBucket',
      ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
      run: async () => {
        const exists = await client.bucketExists(config.bucket);

        if (!exists) {
          await client.makeBucket(config.bucket, config.region);
        }
      },
    }).catch((err: unknown) => {
      bucketReady = null;
      throw err;
    });

    await bucketReady;
  };

  const deleteObject = async (objectKey: string): Promise<void> => {
    await ensureBucket();

    await runObjectStorageOperation({
      config,
      logger,
      operation: 'objectStorage.deleteObject',
      data: { objectKey },
      ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
      run: async () => {
        try {
          await client.removeObject(config.bucket, objectKey);
        } catch (err) {
          if (isNotFoundStorageError(err)) {
            return;
          }

          throw err;
        }
      },
    });
  };

  return {
    bucket: config.bucket,
    ensureBucket,

    async putObject({ objectKey, body, contentType, cacheControl }: PutObjectInput) {
      await ensureBucket();

      await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.putObject',
        data: { contentType, objectKey, sizeBytes: body.length },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          await client.putObject(config.bucket, objectKey, body, body.length, {
            'Content-Type': contentType,
            ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
          });
        },
      });
    },

    deleteObject,

    async deleteObjects(objectKeys: readonly string[]) {
      const uniqueKeys = [...new Set(objectKeys)];

      await Promise.all(uniqueKeys.map((objectKey) => deleteObject(objectKey)));
    },

    async getSignedUrl(objectKey: string) {
      await ensureBucket();
      const signedUrl = await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.getSignedUrl',
        data: { objectKey, signedUrlTtlSeconds: config.signedUrlTtlSeconds },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: () => client.presignedGetObject(config.bucket, objectKey, config.signedUrlTtlSeconds),
      });

      return rewriteSignedUrlOrigin(signedUrl, config.publicUrl);
    },

    async checkReady() {
      await ensureBucket();
      await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.checkReady',
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          await client.statObject(config.bucket, '.readiness').catch((err: unknown) => {
            if (!isNotFoundStorageError(err)) {
              throw err;
            }
          });
        },
      });
    },
  };
};
