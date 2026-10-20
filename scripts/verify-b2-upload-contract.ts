import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import {
  createObjectStorage,
  createS3Client,
  createS3ObjectStorageClient,
  createS3SigningClient,
} from '../src/lib/objectStorage.js';
import type { ObjectStorageConfig } from '../src/config/env.schema.js';

// Opt-in provider qualification: no production configuration or bucket creation.
// Only objects under this run's unpredictable prefix are written or removed.
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} for an isolated B2 test bucket`);
  return value;
};
const endpoint = new URL(required('B2_TEST_ENDPOINT'));
if (
  endpoint.protocol !== 'https:' ||
  !endpoint.hostname.endsWith('.backblazeb2.com') ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.pathname !== '/'
) {
  throw new Error('B2_TEST_ENDPOINT must be an HTTPS Backblaze S3 origin');
}
const config: ObjectStorageConfig = {
  endpoint: endpoint.origin,
  publicUrl: endpoint.origin,
  bucket: required('B2_TEST_BUCKET'),
  region: required('B2_TEST_REGION'),
  accessKey: required('B2_TEST_ACCESS_KEY_ID'),
  secretKey: required('B2_TEST_SECRET_ACCESS_KEY'),
  signedUrlTtlSeconds: 900,
  operationTimeoutMs: 10_000,
};
const client = createS3ObjectStorageClient(config);
client.createBucket = () =>
  Promise.reject(
    new Error('B2 qualification requires an existing isolated bucket; it never creates buckets'),
  );
const signer = createS3SigningClient(config);
const sdk = createS3Client(config);
const storage = createObjectStorage(
  config,
  client,
  {
    info: () => undefined,
    warn: () => undefined,
  },
  signer,
);
const prefix = `contract-tests/idle-reservations/${randomUUID()}/`;
const handles: { objectKey: string; uploadId: string }[] = [];
const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
const begin = async (name: string) => {
  const objectKey = `${prefix}${name}.bin`;
  const { uploadId } = await storage.initiateMultipartUpload({ objectKey });
  const handle = { objectKey, uploadId };
  handles.push(handle);
  return handle;
};
const put = async (url: string, body: Buffer) => {
  const response = await fetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    code: text.match(/<Code>([^<]+)<\/Code>/)?.[1],
  };
};

const cleanupErrors: unknown[] = [];
let operationError: Error | undefined;
try {
  assert(await client.bucketExists(config.bucket), 'The isolated B2 bucket must already exist');
  const expired = await begin('expired-capability');
  const expiringUrl = await storage.signMultipartUploadPart({
    ...expired,
    partNumber: 1,
    expiresAt: new Date(Date.now() + 2_500),
  });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const expiredPut = await put(expiringUrl, Buffer.from([1]));
  assert(
    expiredPut.status >= 400 && expiredPut.status < 500,
    'B2 must reject a real PUT started after its signed URL expired',
  );
  assert(
    (await storage.listMultipartUploadParts({ ...expired, limit: 1 })).parts.length === 0,
    'An expired capability must not store a part',
  );
  const complete = await begin('completed');
  const expiresAt = new Date(Date.now() + 120_000);
  const firstUrl = await storage.signMultipartUploadPart({ ...complete, partNumber: 1, expiresAt });
  const ttl = Number(new URL(firstUrl).searchParams.get('X-Amz-Expires'));
  assert(ttl > 0 && ttl <= 120, 'The real URL must respect the reservation signing deadline');
  const body = Buffer.alloc(5 * 1024 * 1024, 1);
  const first = await put(firstUrl, body);
  assert(first.status === 200 && first.etag !== null, 'B2 must accept the first real part');
  const rewritten = await put(firstUrl, Buffer.alloc(body.length, 2));
  assert(rewritten.status === 200 && rewritten.etag !== null, 'B2 must support same-part retries');
  const beforeLast = await storage.listMultipartUploadParts({ ...complete, limit: 2 });
  assert(
    !beforeLast.truncated &&
      beforeLast.parts.length === 1 &&
      beforeLast.parts[0]?.sizeBytes === body.length,
    'A part rewrite must not appear as additional useful progress in ListParts',
  );
  const lastUrl = await storage.signMultipartUploadPart({ ...complete, partNumber: 2, expiresAt });
  const last = await put(lastUrl, Buffer.alloc(7, 3));
  assert(last.status === 200 && last.etag !== null, 'B2 must accept the short last part');
  const listed = await storage.listMultipartUploadParts({ ...complete, limit: 2 });
  assert(
    !listed.truncated && listed.parts.length === 2 && listed.parts[1]?.sizeBytes === 7,
    'B2 must expose complete and final-part sizes to backend progress verification',
  );
  assert(
    (await storage.listMultipartUploadParts({ ...complete, limit: 1 })).truncated,
    'A bounded listing must report that additional parts exist',
  );
  if (!rewritten.etag || !last.etag) throw new Error('Missing real B2 ETags');
  const parts = [
    { partNumber: 1, etag: rewritten.etag },
    { partNumber: 2, etag: last.etag },
  ];
  await storage.completeMultipartUpload({ ...complete, parts }); // Deliberately discard its response.
  try {
    await storage.completeMultipartUpload({ ...complete, parts });
  } catch {
    // A missing upload after a lost response is resolved by real HEAD below.
  }
  assert(
    (await storage.headObject(complete))?.sizeBytes === body.length + 7,
    'HEAD must recover the correct object after completion response loss/retry',
  );
  assert(
    (await sdk.send(new HeadObjectCommand({ Bucket: config.bucket, Key: complete.objectKey })))
      .VersionId !== undefined,
    'B2 must expose the object version so the test can clean up its own data',
  );
  const completedReplay = await put(firstUrl, body);
  assert(
    completedReplay.status >= 400 &&
      completedReplay.status < 500 &&
      completedReplay.code === 'NoSuchUpload',
    'An old part capability must not recreate an already completed multipart upload',
  );

  const aborted = await begin('aborted');
  const abortedUrl = await storage.signMultipartUploadPart({
    ...aborted,
    partNumber: 1,
    expiresAt: new Date(Date.now() + 120_000),
  });
  assert(
    (await put(abortedUrl, body)).status === 200,
    'The aborted case must first contain real data',
  );
  await storage.abortMultipartUpload(aborted);
  const abortedReplay = await put(abortedUrl, body);
  assert(
    abortedReplay.status >= 400 &&
      abortedReplay.status < 500 &&
      abortedReplay.code === 'NoSuchUpload',
    'An old capability must not recreate an aborted multipart upload',
  );
  assert((await storage.headObject(aborted)) === null, 'Aborting must not publish a source object');
  console.log(
    'B2 contract passed: deadline, real URL expiry, parts, retries, useful sizes, completion recovery and abort replay.',
  );
  console.log(
    'Not measured: physical retention/GC, in-flight PUT/abort races, browser behavior or oversized PUT enforcement.',
  );
} catch (error) {
  operationError =
    error instanceof Error ? error : new Error('B2 qualification failed', { cause: error });
} finally {
  // Discover a handle too if an initiation response was lost before begin() recorded it.
  const cleanupHandles = new Map(handles.map((handle) => [handle.uploadId, handle]));
  try {
    const discovered = await storage.listMultipartUploads({ prefix, limit: 1_000 });
    assert(!discovered.truncated, 'Diagnostic multipart cleanup unexpectedly exceeded its bound');
    for (const handle of discovered.uploads) cleanupHandles.set(handle.uploadId, handle);
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const handle of cleanupHandles.values()) {
    try {
      await storage.abortMultipartUpload(handle);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    const versions = await sdk.send(
      new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: prefix, MaxKeys: 1000 }),
    );
    assert(!versions.IsTruncated, 'Diagnostic version cleanup unexpectedly exceeded its bound');
    for (const version of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]) {
      if (
        version.Key &&
        handles.some((handle) => handle.objectKey === version.Key) &&
        version.VersionId
      ) {
        await sdk.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: version.Key,
            VersionId: version.VersionId,
          }),
        );
      }
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  client.destroy();
  signer.destroy();
  sdk.destroy();
}
if (cleanupErrors.length)
  throw new AggregateError(
    [...(operationError ? [operationError] : []), ...cleanupErrors],
    `B2 diagnostic cleanup did not finish; inspect prefix ${prefix} in the isolated bucket before retrying`,
  );
if (operationError) throw operationError;
