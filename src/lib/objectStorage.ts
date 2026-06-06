import { Client } from 'minio';
import type { Logger } from 'pino';
import type { ObjectStorageConfig } from '../config/env.parsers.js';

type ObjectStorageClient = {
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

export type PutObjectInput = {
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

const runObjectStorageOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
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

  return new Client({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    useSSL: endpoint.protocol === 'https:',
    pathStyle: true,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
};

export const createObjectStorage = (
  config: ObjectStorageConfig,
  client: ObjectStorageClient,
  logger: Pick<Logger, 'warn'>,
): ObjectStorage => {
  let bucketReady: Promise<void> | null = null;

  const ensureBucket = async (): Promise<void> => {
    bucketReady ??= runObjectStorageOperation(async () => {
      const exists = await client.bucketExists(config.bucket);

      if (!exists) {
        await client.makeBucket(config.bucket, config.region);
      }
    }).catch((err: unknown) => {
      bucketReady = null;
      throw err;
    });

    await bucketReady;
  };

  const deleteObject = async (objectKey: string): Promise<void> => {
    await ensureBucket();

    try {
      await client.removeObject(config.bucket, objectKey);
    } catch (err) {
      if (isNotFoundStorageError(err)) {
        return;
      }

      throw toObjectStorageUnavailableError(err);
    }
  };

  return {
    bucket: config.bucket,
    ensureBucket,

    async putObject({ objectKey, body, contentType, cacheControl }: PutObjectInput) {
      await ensureBucket();

      await runObjectStorageOperation(async () => {
        await client.putObject(config.bucket, objectKey, body, body.length, {
          'Content-Type': contentType,
          ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
        });
      });
    },

    deleteObject,

    async deleteObjects(objectKeys: readonly string[]) {
      const uniqueKeys = [...new Set(objectKeys)];

      await Promise.all(
        uniqueKeys.map((objectKey) =>
          deleteObject(objectKey).catch((err: unknown) => {
            logger.warn({ err, objectKey }, 'Object storage delete failed');
            throw err;
          }),
        ),
      );
    },

    async getSignedUrl(objectKey: string) {
      await ensureBucket();
      const signedUrl = await runObjectStorageOperation(() =>
        client.presignedGetObject(config.bucket, objectKey, config.signedUrlTtlSeconds),
      );

      return rewriteSignedUrlOrigin(signedUrl, config.publicUrl);
    },

    async checkReady() {
      await ensureBucket();
      await client.statObject(config.bucket, '.readiness').catch((err: unknown) => {
        if (!isNotFoundStorageError(err)) {
          throw toObjectStorageUnavailableError(err);
        }
      });
    },
  };
};
