import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Readable } from 'node:stream';
import { Client } from 'minio';
import type { ObjectStorageConfig } from '../config/env.parsers.js';
import { observeOperation, type OperationLogger } from './operationMetrics.js';

type ObjectStorageClient = {
  abortActiveRequests?(): void;
  abortMultipartUpload?(bucketName: string, objectName: string, uploadId: string): Promise<void>;
  bucketExists(bucketName: string): Promise<boolean>;
  completeMultipartUpload?(
    bucketName: string,
    objectName: string,
    uploadId: string,
    parts: { part: number; etag?: string }[],
  ): Promise<unknown>;
  initiateNewMultipartUpload?(
    bucketName: string,
    objectName: string,
    headers: Record<string, string>,
  ): Promise<string>;
  fGetObject?(bucketName: string, objectName: string, destinationPath: string): Promise<void>;
  listIncompleteUploads?(bucketName: string, prefix: string, recursive: boolean): Readable;
  listObjectsV2?(bucketName: string, prefix: string, recursive: boolean): Readable;
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
  presignedUrl?(
    method: string,
    bucketName: string,
    objectName: string,
    expires?: number,
    reqParams?: Record<string, string>,
  ): Promise<string>;
};

type ObjectStorageSigningClient = Pick<
  ObjectStorageClient,
  'abortActiveRequests' | 'presignedGetObject' | 'presignedUrl'
>;

export type ObjectStorage = {
  bucket: string;
  abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void>;
  completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<void>;
  downloadObject(input: DownloadObjectInput): Promise<void>;
  ensureBucket(bucket?: string): Promise<void>;
  initiateMultipartUpload(input: InitiateMultipartUploadInput): Promise<MultipartUpload>;
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(objectKey: string, bucket?: string): Promise<void>;
  deleteObjects(objectKeys: readonly string[], bucket?: string): Promise<void>;
  getSignedUrl(objectKey: string, bucket?: string): Promise<string>;
  headObject(input: ObjectStorageSelector): Promise<ObjectStorageObject | null>;
  listMultipartUploads(input: ListMultipartUploadsInput): Promise<ListMultipartUploadsResult>;
  listObjects(input: ListObjectsInput): Promise<ListObjectsResult>;
  signMultipartUploadPart(input: SignMultipartUploadPartInput): Promise<string>;
  checkReady(bucket?: string): Promise<void>;
};

export type MultipartUpload = {
  uploadId: string;
};

export type MultipartUploadPart = {
  partNumber: number;
  etag: string;
};

type PutObjectInput = {
  bucket?: string;
  objectKey: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
};

type InitiateMultipartUploadInput = {
  bucket?: string;
  objectKey: string;
  contentType?: string;
};

type ObjectStorageSelector = {
  bucket?: string;
  objectKey: string;
};

type DownloadObjectInput = ObjectStorageSelector & {
  destinationPath: string;
};

export type ObjectStorageObject = {
  objectKey: string;
  sizeBytes: number;
};

type ListObjectsInput = {
  bucket?: string;
  prefix: string;
  limit: number;
};

type ListObjectsResult = {
  objects: ObjectStorageObject[];
  truncated: boolean;
};

type ObjectStorageMultipartUpload = {
  objectKey: string;
  uploadId: string;
};

type ListMultipartUploadsInput = {
  bucket?: string;
  prefix: string;
  limit: number;
};

type ListMultipartUploadsResult = {
  uploads: ObjectStorageMultipartUpload[];
  truncated: boolean;
};

type SignMultipartUploadPartInput = {
  bucket?: string;
  objectKey: string;
  uploadId: string;
  partNumber: number;
};

type CompleteMultipartUploadInput = {
  bucket?: string;
  objectKey: string;
  uploadId: string;
  parts: readonly MultipartUploadPart[];
};

type AbortMultipartUploadInput = {
  bucket?: string;
  objectKey: string;
  uploadId: string;
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
  abortMultipartUpload: () => rejectUnavailableObjectStorage<void>(),
  completeMultipartUpload: () => rejectUnavailableObjectStorage<void>(),
  downloadObject: () => rejectUnavailableObjectStorage<void>(),
  ensureBucket: () => rejectUnavailableObjectStorage<void>(),
  initiateMultipartUpload: () => rejectUnavailableObjectStorage<MultipartUpload>(),
  putObject: () => rejectUnavailableObjectStorage<void>(),
  deleteObject: () => rejectUnavailableObjectStorage<void>(),
  deleteObjects: () => rejectUnavailableObjectStorage<void>(),
  getSignedUrl: () => rejectUnavailableObjectStorage<string>(),
  headObject: () => rejectUnavailableObjectStorage<ObjectStorageObject | null>(),
  listMultipartUploads: () => rejectUnavailableObjectStorage<ListMultipartUploadsResult>(),
  listObjects: () => rejectUnavailableObjectStorage<ListObjectsResult>(),
  signMultipartUploadPart: () => rejectUnavailableObjectStorage<string>(),
  checkReady: () => rejectUnavailableObjectStorage<void>(),
});

const isNotFoundStorageError = (err: unknown): boolean => {
  if (!(err instanceof Error)) {
    return false;
  }

  const error = err as Error & {
    code?: unknown;
  };

  return error.code === 'NoSuchKey' || error.code === 'NoSuchUpload' || error.code === 'NotFound';
};

const createUnsupportedMultipartError = (): ObjectStorageUnavailableError =>
  new ObjectStorageUnavailableError('Object storage client does not support multipart uploads');

const createUnsupportedObjectStorageOperationError = (
  operation: string,
): ObjectStorageUnavailableError =>
  new ObjectStorageUnavailableError(`Object storage client does not support ${operation}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readNonNegativeSafeInteger = (value: unknown): number | null =>
  Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 ? value : null;

const toListedObject = (value: unknown): ObjectStorageObject | null => {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }

  const sizeBytes = readNonNegativeSafeInteger(value.size);

  return sizeBytes === null ? null : { objectKey: value.name, sizeBytes };
};

const toMultipartUpload = (value: unknown): ObjectStorageMultipartUpload | null => {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.uploadId !== 'string') {
    return null;
  }

  return {
    objectKey: value.key,
    uploadId: value.uploadId,
  };
};

const collectStreamItems = <T>(
  stream: Readable,
  limit: number,
  parse: (value: unknown) => T | null,
): Promise<{ items: T[]; truncated: boolean }> =>
  new Promise((resolve, reject) => {
    const items: T[] = [];
    let settled = false;

    stream.on('data', (value: unknown) => {
      if (settled) {
        return;
      }

      const item = parse(value);

      if (!item) {
        return;
      }

      if (items.length === limit) {
        settled = true;
        stream.destroy();
        resolve({ items, truncated: true });
        return;
      }

      items.push(item);
    });
    stream.on('end', () => {
      if (!settled) {
        settled = true;
        resolve({ items, truncated: false });
      }
    });
    stream.on('error', (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(
          err instanceof Error
            ? err
            : new Error('Object storage list stream failed', { cause: err }),
        );
      }
    });
  });

const assertListLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError('Object storage list limit must be a positive integer');
  }
};

const createMinioClientForEndpoint = (config: ObjectStorageConfig, endpointUrl: string): Client => {
  const endpoint = new URL(endpointUrl);
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

export const createMinioClient = (config: ObjectStorageConfig): Client =>
  createMinioClientForEndpoint(config, config.endpoint);

export const createMinioSigningClient = (config: ObjectStorageConfig): Client =>
  createMinioClientForEndpoint(config, config.publicUrl);

export const createObjectStorage = (
  config: ObjectStorageConfig,
  client: ObjectStorageClient,
  logger: OperationLogger,
  signingClient: ObjectStorageSigningClient = client,
): ObjectStorage => {
  const bucketReady = new Map<string, Promise<void>>();
  const abortActiveRequests = client.abortActiveRequests
    ? (): void => client.abortActiveRequests?.()
    : undefined;
  const abortActiveSigningRequests = signingClient.abortActiveRequests
    ? (): void => signingClient.abortActiveRequests?.()
    : undefined;

  const ensureBucket = async (bucket = config.bucket): Promise<void> => {
    let initialization = bucketReady.get(bucket);

    if (!initialization) {
      initialization = runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.ensureBucket',
        data: { bucket },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          const exists = await client.bucketExists(bucket);

          if (!exists) {
            await client.makeBucket(bucket, config.region);
          }
        },
      }).catch((err: unknown) => {
        bucketReady.delete(bucket);
        throw err;
      });
      bucketReady.set(bucket, initialization);
    }

    await initialization;
  };

  const deleteObject = async (objectKey: string, bucket = config.bucket): Promise<void> => {
    await ensureBucket(bucket);

    await runObjectStorageOperation({
      config,
      logger,
      operation: 'objectStorage.deleteObject',
      data: { bucket, objectKey },
      ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
      run: async () => {
        try {
          await client.removeObject(bucket, objectKey);
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
    async abortMultipartUpload({ bucket = config.bucket, objectKey, uploadId }) {
      await ensureBucket(bucket);

      await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.abortMultipartUpload',
        data: { bucket, objectKey },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          if (!client.abortMultipartUpload) {
            throw createUnsupportedMultipartError();
          }

          try {
            await client.abortMultipartUpload(bucket, objectKey, uploadId);
          } catch (err) {
            if (isNotFoundStorageError(err)) {
              return;
            }

            throw err;
          }
        },
      });
    },

    async completeMultipartUpload({ bucket = config.bucket, objectKey, parts, uploadId }) {
      await ensureBucket(bucket);

      await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.completeMultipartUpload',
        data: { bucket, objectKey, partCount: parts.length },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          if (!client.completeMultipartUpload) {
            throw createUnsupportedMultipartError();
          }

          await client.completeMultipartUpload(
            bucket,
            objectKey,
            uploadId,
            parts.map((part) => ({ part: part.partNumber, etag: part.etag })),
          );
        },
      });
    },

    async downloadObject({ bucket = config.bucket, destinationPath, objectKey }) {
      await ensureBucket(bucket);

      await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.downloadObject',
        data: { bucket, objectKey },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: () => {
          if (!client.fGetObject) {
            throw createUnsupportedObjectStorageOperationError('object downloads');
          }

          return client.fGetObject(bucket, objectKey, destinationPath);
        },
      });
    },

    ensureBucket,

    async initiateMultipartUpload({
      bucket = config.bucket,
      contentType = 'application/octet-stream',
      objectKey,
    }) {
      await ensureBucket(bucket);
      const uploadId = await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.initiateMultipartUpload',
        data: { bucket, contentType, objectKey },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: () => {
          if (!client.initiateNewMultipartUpload) {
            throw createUnsupportedMultipartError();
          }

          return client.initiateNewMultipartUpload(bucket, objectKey, {
            'Content-Type': contentType,
          });
        },
      });

      return { uploadId };
    },

    async putObject({
      bucket = config.bucket,
      objectKey,
      body,
      contentType,
      cacheControl,
    }: PutObjectInput) {
      await ensureBucket(bucket);

      await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.putObject',
        data: { bucket, contentType, objectKey, sizeBytes: body.length },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          await client.putObject(bucket, objectKey, body, body.length, {
            'Content-Type': contentType,
            ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
          });
        },
      });
    },

    deleteObject,

    async deleteObjects(objectKeys: readonly string[], bucket = config.bucket) {
      const uniqueKeys = [...new Set(objectKeys)];

      await Promise.all(uniqueKeys.map((objectKey) => deleteObject(objectKey, bucket)));
    },

    async getSignedUrl(objectKey: string, bucket = config.bucket) {
      await ensureBucket(bucket);
      const signedUrl = await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.getSignedUrl',
        data: { bucket, objectKey, signedUrlTtlSeconds: config.signedUrlTtlSeconds },
        ...(abortActiveSigningRequests ? { onAbort: abortActiveSigningRequests } : {}),
        run: () => signingClient.presignedGetObject(bucket, objectKey, config.signedUrlTtlSeconds),
      });

      return signedUrl;
    },

    async headObject({ bucket = config.bucket, objectKey }) {
      await ensureBucket(bucket);

      return runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.headObject',
        data: { bucket, objectKey },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          try {
            const result = await client.statObject(bucket, objectKey);

            if (!isRecord(result)) {
              throw new Error('Object storage returned invalid object metadata');
            }

            const sizeBytes = readNonNegativeSafeInteger(result.size);

            if (sizeBytes === null) {
              throw new Error('Object storage returned an invalid object size');
            }

            return { objectKey, sizeBytes };
          } catch (err) {
            if (isNotFoundStorageError(err)) {
              return null;
            }

            throw err;
          }
        },
      });
    },

    async listMultipartUploads({ bucket = config.bucket, limit, prefix }) {
      assertListLimit(limit);
      await ensureBucket(bucket);

      return runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.listMultipartUploads',
        data: { bucket, limit, prefix },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          if (!client.listIncompleteUploads) {
            throw createUnsupportedObjectStorageOperationError('multipart upload listing');
          }

          const result = await collectStreamItems(
            client.listIncompleteUploads(bucket, prefix, true),
            limit,
            toMultipartUpload,
          );

          return {
            uploads: result.items,
            truncated: result.truncated,
          };
        },
      });
    },

    async listObjects({ bucket = config.bucket, limit, prefix }) {
      assertListLimit(limit);
      await ensureBucket(bucket);

      return runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.listObjects',
        data: { bucket, limit, prefix },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          if (!client.listObjectsV2) {
            throw createUnsupportedObjectStorageOperationError('object listing');
          }

          const result = await collectStreamItems(
            client.listObjectsV2(bucket, prefix, true),
            limit,
            toListedObject,
          );

          return {
            objects: result.items,
            truncated: result.truncated,
          };
        },
      });
    },

    async signMultipartUploadPart({ bucket = config.bucket, objectKey, partNumber, uploadId }) {
      await ensureBucket(bucket);
      const signedUrl = await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.signMultipartUploadPart',
        data: { bucket, objectKey, partNumber },
        ...(abortActiveSigningRequests ? { onAbort: abortActiveSigningRequests } : {}),
        run: () => {
          if (!signingClient.presignedUrl) {
            throw createUnsupportedMultipartError();
          }

          return signingClient.presignedUrl('PUT', bucket, objectKey, config.signedUrlTtlSeconds, {
            partNumber: String(partNumber),
            uploadId,
          });
        },
      });

      return signedUrl;
    },

    async checkReady(bucket = config.bucket) {
      await ensureBucket(bucket);
      await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.checkReady',
        data: { bucket },
        ...(abortActiveRequests ? { onAbort: abortActiveRequests } : {}),
        run: async () => {
          await client.statObject(bucket, '.readiness').catch((err: unknown) => {
            if (!isNotFoundStorageError(err)) {
              throw err;
            }
          });
        },
      });
    },
  };
};
