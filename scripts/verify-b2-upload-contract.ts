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
  // Diagnostic observation window only; does not change runtime configuration.
  operationTimeoutMs: 60_000,
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
  const startedAt = Date.now();
  const context = { stage: name, timeoutMs: config.operationTimeoutMs };
  console.log(`B2 multipart initiation started: ${JSON.stringify(context)}`);
  const objectKey = `${prefix}${name}.bin`;
  try {
    const { uploadId } = await storage.initiateMultipartUpload({ objectKey });
    const handle = { objectKey, uploadId };
    handles.push(handle);
    console.log(
      `B2 multipart initiation succeeded: ${JSON.stringify({ ...context, durationMs: Date.now() - startedAt })}`,
    );
    return handle;
  } catch (error) {
    console.log(
      `B2 multipart initiation failed: ${JSON.stringify({ ...context, durationMs: Date.now() - startedAt })}`,
    );
    throw error;
  }
};
const PUT_TIMEOUT_MS = 60_000;
const TRANSFER_URL_TTL_SECONDS = 300;
const put = async (stage: string, url: string, body: Buffer) => {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(PUT_TIMEOUT_MS);
  const context = { stage, sizeBytes: body.length, timeoutMs: PUT_TIMEOUT_MS };
  console.log(`B2 PUT started: ${JSON.stringify(context)}`);
  let response: Response | undefined;
  try {
    response = await fetch(url, { method: 'PUT', body, signal });
    const text = await response.text();
    const result = {
      ...context,
      status: response.status,
      etag: response.headers.get('etag'),
      code: text.match(/<Code>([^<]+)<\/Code>/)?.[1],
      durationMs: Date.now() - startedAt,
      requestId: response.headers.get('x-amz-request-id'),
    };
    console.log(`B2 PUT response: ${describePut(result)}`);
    return result;
  } catch (error) {
    // Do not retain the original error: fetch errors can contain the signed URL.
    const failure =
      signal.aborted || (error instanceof Error && error.name === 'TimeoutError')
        ? 'timeout'
        : 'transport-or-response-error';
    // eslint-disable-next-line preserve-caught-error -- The original cause may expose a bearer URL.
    throw new Error(
      `B2 PUT failed: ${JSON.stringify({
        ...context,
        failure,
        phase: response ? 'response-body' : 'response-headers',
        status: response?.status ?? null,
        durationMs: Date.now() - startedAt,
        requestId: response?.headers.get('x-amz-request-id') ?? null,
      })}`,
    );
  }
};
// Never include bearer URLs, ETag values or response bodies in diagnostic errors.
const describePut = (result: Awaited<ReturnType<typeof put>>): string =>
  JSON.stringify({
    stage: result.stage,
    sizeBytes: result.sizeBytes,
    timeoutMs: result.timeoutMs,
    status: result.status,
    code: result.code ?? null,
    hasETag: result.etag !== null,
    durationMs: result.durationMs,
    requestId: result.requestId,
  });

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
  const expiredPut = await put('expired-capability', expiringUrl, Buffer.from([1]));
  assert(
    expiredPut.status >= 400 && expiredPut.status < 500,
    `B2 must reject a real PUT started after its signed URL expired: ${describePut(expiredPut)}`,
  );
  assert(
    (await storage.listMultipartUploadParts({ ...expired, limit: 1 })).parts.length === 0,
    'An expired capability must not store a part',
  );
  const complete = await begin('completed');
  const expiresAt = new Date(Date.now() + TRANSFER_URL_TTL_SECONDS * 1_000);
  const firstUrl = await storage.signMultipartUploadPart({ ...complete, partNumber: 1, expiresAt });
  const ttl = Number(new URL(firstUrl).searchParams.get('X-Amz-Expires'));
  assert(
    ttl > 0 && ttl <= TRANSFER_URL_TTL_SECONDS,
    'The real URL must respect the reservation signing deadline',
  );
  const body = Buffer.alloc(5 * 1024 * 1024, 1);
  const first = await put('first-part', firstUrl, body);
  assert(
    first.status === 200 && first.etag !== null,
    `B2 must accept the first real part: ${describePut(first)}`,
  );
  const rewritten = await put('same-part-rewrite', firstUrl, Buffer.alloc(body.length, 2));
  assert(
    rewritten.status === 200 && rewritten.etag !== null,
    `B2 must support same-part retries: ${describePut(rewritten)}`,
  );
  const beforeLast = await storage.listMultipartUploadParts({ ...complete, limit: 2 });
  assert(
    !beforeLast.truncated &&
      beforeLast.parts.length === 1 &&
      beforeLast.parts[0]?.sizeBytes === body.length,
    'A part rewrite must not appear as additional useful progress in ListParts',
  );
  const lastUrl = await storage.signMultipartUploadPart({ ...complete, partNumber: 2, expiresAt });
  const last = await put('short-last-part', lastUrl, Buffer.alloc(7, 3));
  assert(
    last.status === 200 && last.etag !== null,
    `B2 must accept the short last part: ${describePut(last)}`,
  );
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
  const completedReplay = await put('replay-after-complete', firstUrl, body);
  assert(
    completedReplay.status >= 400 &&
      completedReplay.status < 500 &&
      completedReplay.code === 'NoSuchUpload',
    `An old part capability must not recreate an already completed multipart upload: ${describePut(completedReplay)}`,
  );

  const aborted = await begin('aborted');
  const abortedUrl = await storage.signMultipartUploadPart({
    ...aborted,
    partNumber: 1,
    expiresAt: new Date(Date.now() + TRANSFER_URL_TTL_SECONDS * 1_000),
  });
  const beforeAbort = await put('before-abort', abortedUrl, body);
  assert(
    beforeAbort.status === 200,
    `The aborted case must first contain real data: ${describePut(beforeAbort)}`,
  );
  await storage.abortMultipartUpload(aborted);
  const abortedReplay = await put('replay-after-abort', abortedUrl, body);
  assert(
    abortedReplay.status >= 400 &&
      abortedReplay.status < 500 &&
      abortedReplay.code === 'NoSuchUpload',
    `An old capability must not recreate an aborted multipart upload: ${describePut(abortedReplay)}`,
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
