import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStorageConfig } from '../config/env.schema.js';
import {
  observeOperation,
  type OperationLogger,
  type OperationTimeoutError,
} from './operationMetrics.js';

const requestAbortContext = new AsyncLocalStorage<AbortSignal>();

type ObjectStorageClient = {
  abortMultipartUpload?(bucketName: string, objectName: string, uploadId: string): Promise<void>;
  bucketExists(bucketName: string): Promise<boolean>;
  completeMultipartUpload?(
    bucketName: string,
    objectName: string,
    uploadId: string,
    parts: { part: number; etag: string }[],
  ): Promise<unknown>;
  initiateMultipartUpload?(
    bucketName: string,
    objectName: string,
    headers: Record<string, string>,
  ): Promise<string>;
  downloadObject?(bucketName: string, objectName: string, destinationPath: string): Promise<void>;
  getObject?(bucketName: string, objectName: string): Promise<Readable>;
  listMultipartUploads?(bucketName: string, prefix: string): Readable;
  listMultipartUploadParts?(bucketName: string, objectName: string, uploadId: string): Readable;
  listObjects?(bucketName: string, prefix: string): Readable;
  createBucket(bucketName: string): Promise<void>;
  putObject(
    bucketName: string,
    objectName: string,
    stream: Buffer,
    size?: number,
    metaData?: Record<string, string>,
  ): Promise<unknown>;
  deleteObject(bucketName: string, objectName: string): Promise<void>;
  headObject(bucketName: string, objectName: string): Promise<unknown>;
  signGetObjectUrl?(bucketName: string, objectName: string, expires: number): Promise<string>;
  signMultipartUploadPartUrl?(
    bucketName: string,
    objectName: string,
    uploadId: string,
    partNumber: number,
    expires: number,
    signingDate?: Date,
  ): Promise<string>;
  destroy?(): void;
};

type ObjectStorageSigningClient = Pick<
  ObjectStorageClient,
  'signGetObjectUrl' | 'signMultipartUploadPartUrl' | 'destroy'
>;

type ManagedObjectStorageClient = ObjectStorageClient & {
  destroy(): void;
};

type ObjectStorageSigningClientFactory = {
  signGetObjectUrl: NonNullable<ObjectStorageClient['signGetObjectUrl']>;
  signMultipartUploadPartUrl: NonNullable<ObjectStorageClient['signMultipartUploadPartUrl']>;
  destroy(): void;
};

type S3SigningClientAdapter = Pick<
  ObjectStorageSigningClientFactory,
  'signGetObjectUrl' | 'signMultipartUploadPartUrl'
>;

export type ObjectStorage = {
  bucket: string;
  abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void>;
  completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<void>;
  downloadObject(input: DownloadObjectInput): Promise<void>;
  readObject(input: ReadObjectInput): Promise<Buffer | null>;
  ensureBucket(bucket?: string): Promise<void>;
  initiateMultipartUpload(input: InitiateMultipartUploadInput): Promise<MultipartUpload>;
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(objectKey: string, bucket?: string): Promise<void>;
  deleteObjects(objectKeys: readonly string[], bucket?: string): Promise<void>;
  getSignedUrl(objectKey: string, bucket?: string): Promise<string>;
  headObject(input: ObjectStorageSelector): Promise<ObjectStorageObject | null>;
  listMultipartUploads(input: ListMultipartUploadsInput): Promise<ListMultipartUploadsResult>;
  listMultipartUploadParts(
    input: ListMultipartUploadPartsInput,
  ): Promise<ListMultipartUploadPartsResult>;
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

type ReadObjectInput = ObjectStorageSelector & {
  maxBytes: number;
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
  expiresAt?: Date;
};

export type StoredMultipartUploadPart = { partNumber: number; sizeBytes: number };
type ListMultipartUploadPartsInput = ObjectStorageSelector & { uploadId: string; limit: number };
type ListMultipartUploadPartsResult = { parts: StoredMultipartUploadPart[]; truncated: boolean };

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

export type MultipartCompletionRejectionCode =
  | 'InvalidPart'
  | 'InvalidPartOrder'
  | 'EntityTooSmall'
  | 'NoSuchUpload'
  | 'InvalidRequest'
  | 'MalformedXML';

export class MultipartCompletionRejectedError extends Error {
  constructor(
    readonly code: MultipartCompletionRejectionCode,
    options: ErrorOptions = {},
  ) {
    super('Object storage rejected the multipart completion', options);
    this.name = 'MultipartCompletionRejectedError';
  }
}

const multipartCompletionRejectionCode = (
  err: unknown,
): MultipartCompletionRejectionCode | null => {
  if (!(err instanceof Error)) {
    return null;
  }

  const code = isRecord(err) && typeof err.code === 'string' ? err.code : err.name;
  switch (code) {
    case 'InvalidPart':
    case 'InvalidPartOrder':
    case 'EntityTooSmall':
    case 'NoSuchUpload':
    case 'MalformedXML':
      return code;
    case 'InvalidRequest':
      return err.message === 'Bad request: No data was uploaded' ? code : null;
    default:
      return null;
  }
};

const rejectUnavailableObjectStorage = <T = never>(): Promise<T> =>
  Promise.reject(new ObjectStorageUnavailableError());

const toObjectStorageError = (
  err: unknown,
): ObjectStorageUnavailableError | MultipartCompletionRejectedError =>
  err instanceof ObjectStorageUnavailableError || err instanceof MultipartCompletionRejectedError
    ? err
    : new ObjectStorageUnavailableError(undefined, { cause: err });

const runObjectStorageOperation = async <T>({
  config,
  data = {},
  logger,
  operation,
  run,
}: {
  config: ObjectStorageConfig;
  data?: Record<string, unknown>;
  logger: OperationLogger;
  operation: string;
  run: () => Promise<T>;
}): Promise<T> => {
  const abortController = new AbortController();

  try {
    return await observeOperation({
      operation,
      timeoutMs: config.operationTimeoutMs,
      logger,
      data: {
        bucket: config.bucket,
        ...data,
      },
      successMessage: 'Object storage operation completed',
      failureMessage: 'Object storage operation failed',
      onAbort: (reason: OperationTimeoutError) => {
        abortController.abort(reason);
      },
      run: () => requestAbortContext.run(abortController.signal, run),
    });
  } catch (err) {
    throw toObjectStorageError(err);
  }
};

export const createUnavailableObjectStorage = (): ObjectStorage => ({
  bucket: '',
  abortMultipartUpload: () => rejectUnavailableObjectStorage<void>(),
  completeMultipartUpload: () => rejectUnavailableObjectStorage<void>(),
  downloadObject: () => rejectUnavailableObjectStorage<void>(),
  readObject: () => rejectUnavailableObjectStorage<Buffer | null>(),
  ensureBucket: () => rejectUnavailableObjectStorage<void>(),
  initiateMultipartUpload: () => rejectUnavailableObjectStorage<MultipartUpload>(),
  putObject: () => rejectUnavailableObjectStorage<void>(),
  deleteObject: () => rejectUnavailableObjectStorage<void>(),
  deleteObjects: () => rejectUnavailableObjectStorage<void>(),
  getSignedUrl: () => rejectUnavailableObjectStorage<string>(),
  headObject: () => rejectUnavailableObjectStorage<ObjectStorageObject | null>(),
  listMultipartUploads: () => rejectUnavailableObjectStorage<ListMultipartUploadsResult>(),
  listMultipartUploadParts: () => rejectUnavailableObjectStorage<ListMultipartUploadPartsResult>(),
  listObjects: () => rejectUnavailableObjectStorage<ListObjectsResult>(),
  signMultipartUploadPart: () => rejectUnavailableObjectStorage<string>(),
  checkReady: () => rejectUnavailableObjectStorage<void>(),
});

const isNotFoundStorageError = (err: unknown): boolean => {
  if (!(err instanceof Error)) {
    return false;
  }

  const code = isRecord(err) ? err.code : undefined;

  return (
    code === 'NoSuchBucket' ||
    code === 'NoSuchKey' ||
    code === 'NoSuchUpload' ||
    code === 'NotFound' ||
    err.name === 'NoSuchBucket' ||
    err.name === 'NoSuchKey' ||
    err.name === 'NoSuchUpload' ||
    err.name === 'NotFound'
  );
};

const createUnsupportedMultipartError = (): ObjectStorageUnavailableError =>
  new ObjectStorageUnavailableError('Object storage client does not support multipart uploads');

const createUnsupportedObjectStorageOperationError = (
  operation: string,
): ObjectStorageUnavailableError =>
  new ObjectStorageUnavailableError(`Object storage client does not support ${operation}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isAsyncByteStream = (value: unknown): value is AsyncIterable<Uint8Array> =>
  isRecord(value) &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === 'function';

const toNodeReadable = (value: unknown): Readable => {
  if (value instanceof Readable) {
    return value;
  }

  if (isAsyncByteStream(value)) {
    return Readable.from(value);
  }

  throw new Error('Object storage returned a body that is not a readable byte stream');
};

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

const toStoredMultipartUploadPart = (value: unknown): StoredMultipartUploadPart | null => {
  if (!isRecord(value)) return null;
  const partNumber = readNonNegativeSafeInteger(value.partNumber);
  const sizeBytes = readNonNegativeSafeInteger(value.sizeBytes);
  if (partNumber === null || partNumber < 1 || partNumber > 10_000 || sizeBytes === null) {
    throw new Error('Object storage returned invalid multipart part metadata');
  }
  return { partNumber, sizeBytes };
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

      let item: T | null;
      try {
        item = parse(value);
      } catch (err) {
        settled = true;
        stream.destroy();
        reject(
          err instanceof Error
            ? err
            : new Error('Object storage list metadata is invalid', { cause: err }),
        );
        return;
      }

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

const readBoundedStream = (stream: Readable, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    let settled = false;

    stream.on('data', (value: unknown) => {
      if (settled) {
        return;
      }

      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array) && typeof value !== 'string') {
        settled = true;
        stream.destroy();
        reject(new Error('Object storage returned an invalid object chunk'));
        return;
      }

      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);

      if (sizeBytes + chunk.length > maxBytes) {
        settled = true;
        stream.destroy();
        reject(new Error(`Object exceeds the ${maxBytes}-byte read limit`));
        return;
      }

      chunks.push(chunk);
      sizeBytes += chunk.length;
    });
    stream.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks, sizeBytes));
      }
    });
    stream.on('error', (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(
          err instanceof Error
            ? err
            : new Error('Object storage read stream failed', { cause: err }),
        );
      }
    });
  });

const assertReadLimit = (maxBytes: number): void => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('Object storage read limit must be a positive integer');
  }
};

const requestOptions = (): { abortSignal?: AbortSignal } => {
  const abortSignal = requestAbortContext.getStore();
  return abortSignal ? { abortSignal } : {};
};

export const createS3Client = (config: ObjectStorageConfig, endpoint = config.endpoint): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });

const createObjectStorageClientAdapter = (sdkClient: S3Client): ObjectStorageClient => ({
  async abortMultipartUpload(bucketName, objectName, uploadId) {
    await sdkClient.send(
      new AbortMultipartUploadCommand({
        Bucket: bucketName,
        Key: objectName,
        UploadId: uploadId,
      }),
      requestOptions(),
    );
  },
  async bucketExists(bucketName) {
    try {
      await sdkClient.send(new HeadBucketCommand({ Bucket: bucketName }), requestOptions());
      return true;
    } catch (err) {
      if (isNotFoundStorageError(err)) {
        return false;
      }

      throw err;
    }
  },
  async completeMultipartUpload(bucketName, objectName, uploadId, parts) {
    await sdkClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: objectName,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ etag, part }) => ({ ETag: etag, PartNumber: part })),
        },
      }),
      requestOptions(),
    );
  },
  async createBucket(bucketName) {
    await sdkClient.send(new CreateBucketCommand({ Bucket: bucketName }), requestOptions());
  },
  async downloadObject(bucketName, objectName, destinationPath) {
    const result = await sdkClient.send(
      new GetObjectCommand({ Bucket: bucketName, Key: objectName }),
      requestOptions(),
    );

    if (!result.Body) {
      throw new Error('Object storage returned an empty object body');
    }

    await pipeline(toNodeReadable(result.Body), createWriteStream(destinationPath));
  },
  async getObject(bucketName, objectName) {
    const result = await sdkClient.send(
      new GetObjectCommand({ Bucket: bucketName, Key: objectName }),
      requestOptions(),
    );

    if (!result.Body) {
      throw new Error('Object storage returned an empty object body');
    }

    return toNodeReadable(result.Body);
  },
  listMultipartUploadParts(bucketName, objectName, uploadId) {
    const abortSignal = requestAbortContext.getStore();
    return Readable.from(
      (async function* () {
        let marker = 0;
        let lastPart = 0;
        for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
          const page = await sdkClient.send(
            new ListPartsCommand({
              Bucket: bucketName,
              Key: objectName,
              UploadId: uploadId,
              MaxParts: 1_000,
              PartNumberMarker: String(marker),
            }),
            abortSignal ? { abortSignal } : {},
          );
          for (const part of page.Parts ?? []) {
            const parsed = toStoredMultipartUploadPart({
              partNumber: part.PartNumber,
              sizeBytes: part.Size,
            });
            if (!parsed || parsed.partNumber <= lastPart) {
              throw new Error('Object storage repeated or reordered multipart parts');
            }
            lastPart = parsed.partNumber;
            yield parsed;
          }
          if (!page.IsTruncated) return;
          const next = Number(page.NextPartNumberMarker);
          if (!Number.isSafeInteger(next) || next <= marker || next < lastPart || next > 10_000) {
            throw new Error('Object storage returned an invalid part pagination marker');
          }
          marker = next;
        }
        throw new Error('Object storage exceeded the multipart part pagination bound');
      })(),
    );
  },
  listMultipartUploads(bucketName, prefix) {
    const abortSignal = requestAbortContext.getStore();

    return Readable.from(
      (async function* () {
        let keyMarker: string | undefined;
        let uploadIdMarker: string | undefined;
        const visitedMarkers = new Set<string>();

        while (true) {
          const page = await sdkClient.send(
            new ListMultipartUploadsCommand({
              Bucket: bucketName,
              Prefix: prefix,
              MaxUploads: 1_000,
              ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
              ...(uploadIdMarker !== undefined ? { UploadIdMarker: uploadIdMarker } : {}),
            }),
            abortSignal ? { abortSignal } : {},
          );

          for (const upload of page.Uploads ?? []) {
            if (upload.Key && upload.UploadId) {
              yield { key: upload.Key, uploadId: upload.UploadId };
            }
          }

          if (!page.IsTruncated) {
            return;
          }

          const nextKeyMarker = page.NextKeyMarker;
          const nextUploadIdMarker = page.NextUploadIdMarker;

          if (!nextKeyMarker) {
            throw new Error(
              'Object storage returned a truncated multipart page without a key marker',
            );
          }

          if (!nextUploadIdMarker) {
            throw new Error(
              'Object storage returned a truncated multipart page without an upload ID marker',
            );
          }

          const marker = JSON.stringify([nextKeyMarker, nextUploadIdMarker]);

          if (
            visitedMarkers.has(marker) ||
            (nextKeyMarker === keyMarker && nextUploadIdMarker === uploadIdMarker)
          ) {
            throw new Error('Object storage repeated a multipart pagination marker');
          }

          visitedMarkers.add(marker);
          keyMarker = nextKeyMarker;
          uploadIdMarker = nextUploadIdMarker;
        }
      })(),
    );
  },
  listObjects(bucketName, prefix) {
    const abortSignal = requestAbortContext.getStore();

    return Readable.from(
      (async function* () {
        let continuationToken: string | undefined;
        const visitedTokens = new Set<string>();

        while (true) {
          const page = await sdkClient.send(
            new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: prefix,
              MaxKeys: 1_000,
              ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
            }),
            abortSignal ? { abortSignal } : {},
          );

          for (const object of page.Contents ?? []) {
            if (object.Key && object.Size !== undefined) {
              yield { name: object.Key, size: object.Size };
            }
          }

          if (!page.IsTruncated) {
            return;
          }

          const nextToken = page.NextContinuationToken;

          if (!nextToken || visitedTokens.has(nextToken) || nextToken === continuationToken) {
            throw new Error(
              'Object storage returned a repeated or missing object pagination token',
            );
          }

          visitedTokens.add(nextToken);
          continuationToken = nextToken;
        }
      })(),
    );
  },
  async initiateMultipartUpload(bucketName, objectName, headers) {
    const result = await sdkClient.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: objectName,
        ContentType: headers['Content-Type'],
      }),
      requestOptions(),
    );

    if (!result.UploadId) {
      throw new Error('Object storage did not return a multipart upload ID');
    }

    return result.UploadId;
  },
  async putObject(bucketName, objectName, body, _size, metadata) {
    await sdkClient.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectName,
        Body: body,
        ContentLength: body.length,
        ContentType: metadata?.['Content-Type'],
        CacheControl: metadata?.['Cache-Control'],
      }),
      requestOptions(),
    );
  },
  async deleteObject(bucketName, objectName) {
    await sdkClient.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: objectName }),
      requestOptions(),
    );
  },
  async headObject(bucketName, objectName) {
    const result = await sdkClient.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: objectName }),
      requestOptions(),
    );

    return { size: result.ContentLength };
  },
});

const createSigningClientAdapter = (sdkClient: S3Client): S3SigningClientAdapter => ({
  signGetObjectUrl: (bucketName, objectName, expires) =>
    getSignedUrl(sdkClient, new GetObjectCommand({ Bucket: bucketName, Key: objectName }), {
      expiresIn: expires,
    }),
  signMultipartUploadPartUrl: (
    bucketName,
    objectName,
    uploadId,
    partNumber,
    expires,
    signingDate,
  ) =>
    getSignedUrl(
      sdkClient,
      new UploadPartCommand({
        Bucket: bucketName,
        Key: objectName,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expires, ...(signingDate ? { signingDate } : {}) },
    ),
});

export const createS3ObjectStorageClient = (
  config: ObjectStorageConfig,
): ManagedObjectStorageClient => {
  const sdkClient = createS3Client(config);

  return {
    ...createObjectStorageClientAdapter(sdkClient),
    destroy: () => sdkClient.destroy(),
  };
};

export const createS3SigningClient = (
  config: ObjectStorageConfig,
): ObjectStorageSigningClientFactory => {
  const sdkClient = createS3Client(config, config.publicUrl);

  return {
    ...createSigningClientAdapter(sdkClient),
    destroy: () => sdkClient.destroy(),
  };
};

export const createObjectStorage = (
  config: ObjectStorageConfig,
  client: ObjectStorageClient,
  logger: OperationLogger,
  signingClient: ObjectStorageSigningClient = client,
): ObjectStorage => {
  const bucketReady = new Map<string, Promise<void>>();

  const ensureBucket = async (bucket = config.bucket): Promise<void> => {
    let initialization = bucketReady.get(bucket);

    if (!initialization) {
      initialization = runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.ensureBucket',
        data: { bucket },
        run: async () => {
          const exists = await client.bucketExists(bucket);

          if (!exists) {
            await client.createBucket(bucket);
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
      run: async () => {
        try {
          await client.deleteObject(bucket, objectKey);
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
        run: async () => {
          if (!client.completeMultipartUpload) {
            throw createUnsupportedMultipartError();
          }

          try {
            await client.completeMultipartUpload(
              bucket,
              objectKey,
              uploadId,
              parts.map((part) => ({ part: part.partNumber, etag: part.etag })),
            );
          } catch (err) {
            const code = multipartCompletionRejectionCode(err);
            if (code) {
              throw new MultipartCompletionRejectedError(code, { cause: err });
            }
            throw err;
          }
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
        run: () => {
          if (!client.downloadObject) {
            throw createUnsupportedObjectStorageOperationError('object downloads');
          }

          return client.downloadObject(bucket, objectKey, destinationPath);
        },
      });
    },

    async readObject({ bucket = config.bucket, maxBytes, objectKey }) {
      assertReadLimit(maxBytes);
      await ensureBucket(bucket);

      return runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.readObject',
        data: { bucket, maxBytes, objectKey },
        run: async () => {
          if (!client.getObject) {
            throw createUnsupportedObjectStorageOperationError('bounded object reads');
          }

          try {
            return await readBoundedStream(await client.getObject(bucket, objectKey), maxBytes);
          } catch (err) {
            if (isNotFoundStorageError(err)) {
              return null;
            }

            throw err;
          }
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
        run: () => {
          if (!client.initiateMultipartUpload) {
            throw createUnsupportedMultipartError();
          }

          return client.initiateMultipartUpload(bucket, objectKey, {
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
        run: () => {
          if (!signingClient.signGetObjectUrl) {
            throw createUnsupportedObjectStorageOperationError('signed GET URLs');
          }

          return signingClient.signGetObjectUrl(bucket, objectKey, config.signedUrlTtlSeconds);
        },
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
        run: async () => {
          try {
            const result = await client.headObject(bucket, objectKey);

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
        run: async () => {
          if (!client.listMultipartUploads) {
            throw createUnsupportedObjectStorageOperationError('multipart upload listing');
          }

          const result = await collectStreamItems(
            client.listMultipartUploads(bucket, prefix),
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
        run: async () => {
          if (!client.listObjects) {
            throw createUnsupportedObjectStorageOperationError('object listing');
          }

          const result = await collectStreamItems(
            client.listObjects(bucket, prefix),
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

    async listMultipartUploadParts({ bucket = config.bucket, objectKey, uploadId, limit }) {
      assertListLimit(limit);
      await ensureBucket(bucket);
      return runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.listMultipartUploadParts',
        data: { bucket, objectKey },
        run: async () => {
          if (!client.listMultipartUploadParts) {
            throw createUnsupportedObjectStorageOperationError('listing multipart parts');
          }
          const result = await collectStreamItems(
            client.listMultipartUploadParts(bucket, objectKey, uploadId),
            limit,
            toStoredMultipartUploadPart,
          );
          return { parts: result.items, truncated: result.truncated };
        },
      });
    },

    async signMultipartUploadPart({
      bucket = config.bucket,
      objectKey,
      partNumber,
      uploadId,
      expiresAt,
    }) {
      await ensureBucket(bucket);
      const signedUrl = await runObjectStorageOperation({
        config,
        logger,
        operation: 'objectStorage.signMultipartUploadPart',
        data: { bucket, objectKey, partNumber },
        run: () => {
          if (!signingClient.signMultipartUploadPartUrl) {
            throw createUnsupportedMultipartError();
          }

          // Bind the duration and SigV4 timestamp to the same instant, even if signing waits.
          const signingDate = new Date();
          const expires = expiresAt
            ? Math.min(
                config.signedUrlTtlSeconds,
                Math.floor((expiresAt.getTime() - signingDate.getTime()) / 1000),
              )
            : config.signedUrlTtlSeconds;
          if (expires < 1)
            throw new ObjectStorageUnavailableError('Upload signing deadline has passed');
          return signingClient.signMultipartUploadPartUrl(
            bucket,
            objectKey,
            uploadId,
            partNumber,
            expires,
            signingDate,
          );
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
        run: async () => {
          await client.headObject(bucket, '.readiness').catch((err: unknown) => {
            if (!isNotFoundStorageError(err)) {
              throw err;
            }
          });
        },
      });
    },
  };
};
