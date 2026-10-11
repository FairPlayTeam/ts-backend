import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import {
  GetBucketCorsCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createExternalResourceReconciler } from '../../src/services/externalResources.js';
import {
  createS3Client,
  createS3ObjectStorageClient,
  createS3SigningClient,
  createObjectStorage,
} from '../../src/lib/objectStorage.js';
import { createPng } from './support/fixtures.js';
import {
  buildObjectStorageConfig,
  OBJECT_STORAGE_BUCKET,
  startGarageContainer,
  VIDEO_OBJECT_STORAGE_BUCKET,
} from './support/infrastructure.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  createPrismaClient,
  expectIntegrationReadinessOk,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

const execFileAsync = promisify(execFile);

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

const runPostgresContainerCommand = async (
  containerId: string,
  command: readonly string[],
): Promise<string> => {
  try {
    const result = await execFileAsync('docker', ['exec', containerId, ...command]);

    return result.stdout;
  } catch (error) {
    throw new Error('PostgreSQL container command failed', { cause: error });
  }
};

const runPostgresSql = async (container: string, database: string, sql: string): Promise<string> =>
  runPostgresContainerCommand(container, [
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'user',
    '-d',
    database,
    '-c',
    sql,
  ]);

describe('infrastructure integration', () => {
  let runtime: TestRuntime | null = null;

  beforeAll(async () => {
    runtime = await startRuntime();
  });

  beforeEach(async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    await resetState(runtime);
  });

  afterAll(async () => {
    await stopRuntime(runtime);
  });

  test('migrates a populated pre-thumbnail upload session and keeps it usable', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const migrationName = '20260727120000_add_video_source_thumbnails';
    const databaseName = `thumbnail_migration_${randomUUID().replaceAll('-', '')}`;
    const userId = '11111111-1111-4111-8111-111111111111';
    const videoId = '22222222-2222-4222-8222-222222222222';
    const uploadSessionId = '33333333-3333-4333-8333-333333333333';
    const sourceTargetId = '44444444-4444-4444-8444-444444444444';
    let migrationPrisma: PrismaClient | null = null;
    let thumbnailObjectKey: string | null = null;

    await runPostgresContainerCommand(runtime.postgresContainerId, [
      'createdb',
      '-U',
      'user',
      databaseName,
    ]);

    try {
      const migrationsDirectory = resolve(projectRoot, 'prisma', 'migrations');
      const migrationDirectories = (await readdir(migrationsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name < migrationName)
        .map((entry) => entry.name)
        .sort();

      for (const directory of migrationDirectories) {
        const sql = await readFile(
          resolve(migrationsDirectory, directory, 'migration.sql'),
          'utf8',
        );
        await runPostgresSql(runtime.postgresContainerId, databaseName, sql);
      }

      await runPostgresSql(
        runtime.postgresContainerId,
        databaseName,
        `
            INSERT INTO "users" (
              "id", "email", "username", "password_hash", "is_verified",
              "created_at", "updated_at"
            ) VALUES (
              '${userId}', 'preexisting-thumbnail@example.com', 'preexisting_thumb',
              'unused-password-hash', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            INSERT INTO "videos" (
              "id", "public_id", "owner_id", "title", "created_at", "updated_at"
            ) VALUES (
              '${videoId}', 'PreMigration1', '${userId}', 'Pre-migration video',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            INSERT INTO "external_resource_targets" (
              "id", "user_id", "video_id", "bucket", "selector", "selector_kind",
              "role", "generation", "expected_size_bytes", "may_have_multipart_upload",
              "goal", "state", "created_at", "updated_at"
            ) VALUES (
              '${sourceTargetId}', '${userId}', '${videoId}',
              '${VIDEO_OBJECT_STORAGE_BUCKET}',
              '${userId}/${videoId}/sources/${uploadSessionId}/original.mp4',
              'exact', 'source', '${uploadSessionId}', 1, true,
              'present', 'writing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            INSERT INTO "video_upload_sessions" (
              "id", "video_id", "user_id", "status", "bucket", "object_key",
              "part_size_bytes", "expected_size_bytes", "expires_at",
              "external_resource_target_id", "created_at", "updated_at"
            ) VALUES (
              '${uploadSessionId}', '${videoId}', '${userId}', 'initiated',
              '${VIDEO_OBJECT_STORAGE_BUCKET}',
              '${userId}/${videoId}/sources/${uploadSessionId}/original.mp4',
              67108864, 1, '2099-01-01T00:00:00.000Z',
              '${sourceTargetId}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
          `,
      );

      const thumbnailMigration = await readFile(
        resolve(migrationsDirectory, migrationName, 'migration.sql'),
        'utf8',
      );
      const enumStatementEnd = thumbnailMigration.indexOf(';') + 1;

      if (enumStatementEnd <= 0) {
        throw new Error('Thumbnail migration enum statement was not found');
      }

      await runPostgresSql(
        runtime.postgresContainerId,
        databaseName,
        thumbnailMigration.slice(0, enumStatementEnd),
      );
      await runPostgresSql(
        runtime.postgresContainerId,
        databaseName,
        thumbnailMigration.slice(enumStatementEnd),
      );

      const migratedDatabaseUrl = new URL(runtime.databaseUrl);
      migratedDatabaseUrl.pathname = `/${databaseName}`;
      migrationPrisma = createPrismaClient(migratedDatabaseUrl.toString());
      const migrationExternalResources = createExternalResourceReconciler({
        prisma: migrationPrisma,
        objectStorage: runtime.videoObjectStorage,
        clock: {
          now: () => new Date(),
        },
        logger: testLogger,
      });
      const migrationVideosService = createIntegrationVideosService(
        migrationPrisma,
        runtime.videoObjectStorage,
        migrationExternalResources,
      );
      const preexistingSession = await migrationPrisma.videoUploadSession.findUniqueOrThrow({
        where: {
          id: uploadSessionId,
        },
        include: {
          sourceThumbnail: true,
        },
      });

      expect(preexistingSession).toMatchObject({
        id: uploadSessionId,
        status: 'initiated',
        sourceThumbnail: null,
      });
      await expect(
        migrationVideosService.getMultipartUploadSession({
          userId,
          videoId,
          uploadSessionId,
        }),
      ).resolves.toMatchObject({
        uploadSession: {
          id: uploadSessionId,
          status: 'initiated',
        },
      });

      const thumbnail = await createPng(1600, 900);
      await expect(
        migrationVideosService.uploadSourceThumbnail({
          userId,
          videoId,
          uploadSessionId,
          file: {
            buffer: thumbnail,
            size: thumbnail.length,
          },
        }),
      ).resolves.toMatchObject({
        thumbnail: {
          uploadSessionId,
          width: 1280,
          height: 720,
        },
      });
      thumbnailObjectKey = (
        await migrationPrisma.videoSourceThumbnail.findUniqueOrThrow({
          where: {
            uploadSessionId,
          },
          select: {
            objectKey: true,
          },
        })
      ).objectKey;
    } finally {
      await migrationPrisma?.$disconnect();
      if (thumbnailObjectKey) {
        await runtime.videoObjectStorage.deleteObject(
          thumbnailObjectKey,
          VIDEO_OBJECT_STORAGE_BUCKET,
        );
      }
      await runPostgresContainerCommand(runtime.postgresContainerId, [
        'dropdb',
        '--force',
        '-U',
        'user',
        databaseName,
      ]);
    }
  }, 120_000);

  test('reports readiness against the real database, redis, and object storage clients', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);

    await expectIntegrationReadinessOk(app);
  });

  test('creates both buckets and supports real object CRUD and bounded listing', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const integrationRuntime = runtime;

    await integrationRuntime.objectStorage.ensureBucket();
    await integrationRuntime.videoObjectStorage.ensureBucket();

    const s3Client = createS3Client(integrationRuntime.objectStorageConfig);

    try {
      await expect(
        s3Client.send(new HeadBucketCommand({ Bucket: OBJECT_STORAGE_BUCKET })),
      ).resolves.toBeDefined();
      await expect(
        s3Client.send(new HeadBucketCommand({ Bucket: VIDEO_OBJECT_STORAGE_BUCKET })),
      ).resolves.toBeDefined();
    } finally {
      s3Client.destroy();
    }

    const prefix = `integration/object-contract-${randomUUID()}/`;
    const objectKeys = [`${prefix}one.txt`, `${prefix}two.txt`, `${prefix}three.txt`];
    const body = Buffer.from('Garage object contract');

    await Promise.all(
      objectKeys.map((objectKey) =>
        integrationRuntime.objectStorage.putObject({
          objectKey,
          body,
          contentType: 'text/plain',
        }),
      ),
    );

    await expect(
      integrationRuntime.objectStorage.headObject({ objectKey: objectKeys[0] ?? '' }),
    ).resolves.toEqual({ objectKey: objectKeys[0], sizeBytes: body.length });
    await expect(
      integrationRuntime.objectStorage.readObject({
        objectKey: objectKeys[0] ?? '',
        maxBytes: body.length,
      }),
    ).resolves.toEqual(body);

    const firstPage = await integrationRuntime.objectStorage.listObjects({ prefix, limit: 2 });
    expect(firstPage.objects).toHaveLength(2);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.objects.every(({ objectKey }) => objectKey.startsWith(prefix))).toBe(true);

    await Promise.all(
      objectKeys.map((objectKey) => integrationRuntime.objectStorage.deleteObject(objectKey)),
    );
    await expect(
      integrationRuntime.objectStorage.headObject({ objectKey: objectKeys[0] ?? '' }),
    ).resolves.toBeNull();
  });

  test('paginates same-key incomplete multipart uploads with both S3 markers against Garage', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const integrationRuntime = runtime;

    const prefix = `integration/incomplete-contract-${randomUUID()}/`;
    const uploadCount = 1_001;
    const objectKey = `${prefix}same-key.bin`;
    const uploads: Array<{ objectKey: string; uploadId: string }> = [];
    const s3Client = createS3Client(integrationRuntime.videoObjectStorageConfig);

    try {
      for (let start = 0; start < uploadCount; start += 25) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(25, uploadCount - start) }, async () => {
            const { uploadId } =
              await integrationRuntime.videoObjectStorage.initiateMultipartUpload({
                objectKey,
              });

            return { objectKey, uploadId };
          }),
        );
        uploads.push(...batch);
      }

      const firstPage = await s3Client.send(
        new ListMultipartUploadsCommand({
          Bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          Prefix: prefix,
          MaxUploads: 1_000,
        }),
      );
      expect(firstPage.Uploads).toHaveLength(1_000);
      expect(firstPage.IsTruncated).toBe(true);
      expect(firstPage.NextKeyMarker).toBe(objectKey);
      expect(firstPage.NextUploadIdMarker).toBeTruthy();
      expect(firstPage.NextUploadIdMarker).toBe(firstPage.Uploads?.at(-1)?.UploadId);

      const secondPage = await s3Client.send(
        new ListMultipartUploadsCommand({
          Bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          Prefix: prefix,
          MaxUploads: 1_000,
          KeyMarker: firstPage.NextKeyMarker,
          UploadIdMarker: firstPage.NextUploadIdMarker,
        }),
      );
      expect(secondPage.Uploads).toHaveLength(1);
      expect(secondPage.IsTruncated).toBe(false);
      expect(secondPage.Uploads?.[0]?.Key).toBe(objectKey);
      expect(secondPage.Uploads?.[0]?.UploadId).not.toBe(firstPage.NextUploadIdMarker);

      const listed = await integrationRuntime.videoObjectStorage.listMultipartUploads({
        prefix,
        limit: uploadCount,
      });
      expect(listed.uploads).toHaveLength(uploadCount);
      expect(listed.truncated).toBe(false);
      expect(listed.uploads.every(({ objectKey: key }) => key === objectKey)).toBe(true);
      expect(new Set(listed.uploads.map(({ uploadId }) => uploadId)).size).toBe(uploadCount);

      const limited = await integrationRuntime.videoObjectStorage.listMultipartUploads({
        prefix,
        limit: 999,
      });
      expect(limited.uploads).toHaveLength(999);
      expect(limited.truncated).toBe(true);
      expect(new Set(limited.uploads.map(({ uploadId }) => uploadId)).size).toBe(999);

      for (let start = 0; start < uploads.length; start += 25) {
        await Promise.all(
          uploads
            .slice(start, start + 25)
            .map(({ objectKey, uploadId }) =>
              integrationRuntime.videoObjectStorage.abortMultipartUpload({ objectKey, uploadId }),
            ),
        );
      }

      await expect(
        integrationRuntime.videoObjectStorage.listMultipartUploads({
          prefix,
          limit: uploadCount + 1,
        }),
      ).resolves.toEqual({ uploads: [], truncated: false });
    } finally {
      s3Client.destroy();
      for (let start = 0; start < uploads.length; start += 25) {
        await Promise.all(
          uploads
            .slice(start, start + 25)
            .map(({ objectKey, uploadId }) =>
              integrationRuntime.videoObjectStorage
                .abortMultipartUpload({ objectKey, uploadId })
                .catch(() => undefined),
            ),
        );
      }
    }
  }, 120_000);

  test('persists objects when Garage restarts with the same data volume', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'fairplay-garage-'));
    let objectStorageContainer: Awaited<ReturnType<typeof startGarageContainer>> | null = null;
    const storageClients: Array<
      ReturnType<typeof createS3ObjectStorageClient> | ReturnType<typeof createS3SigningClient>
    > = [];

    const createStorage = (config: ReturnType<typeof buildObjectStorageConfig>) => {
      const storageClient = createS3ObjectStorageClient(config);
      const signingClient = createS3SigningClient(config);
      storageClients.push(storageClient, signingClient);

      return createObjectStorage(config, storageClient, testLogger, signingClient);
    };

    try {
      objectStorageContainer = await startGarageContainer(dataDirectory);
      const firstStorage = createStorage(buildObjectStorageConfig(objectStorageContainer));
      const objectKey = `integration/persist-${randomUUID()}.txt`;
      const body = Buffer.from('persistent Garage object');

      await firstStorage.putObject({ objectKey, body, contentType: 'text/plain' });
      await objectStorageContainer.stop();
      for (const client of storageClients.splice(0)) {
        client.destroy();
      }

      objectStorageContainer = await startGarageContainer(dataDirectory);
      const restartedStorage = createStorage(buildObjectStorageConfig(objectStorageContainer));

      await expect(
        restartedStorage.readObject({ objectKey, maxBytes: body.length }),
      ).resolves.toEqual(body);
    } finally {
      for (const client of storageClients) {
        client.destroy();
      }
      await objectStorageContainer?.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  test('serves signed GETs and accepts signed multipart PUTs through the public object-storage origin', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const storage = runtime.videoObjectStorage;
    expect(runtime.videoObjectStorageConfig.endpoint).not.toBe(
      runtime.videoObjectStorageConfig.publicUrl,
    );
    const s3Client = createS3Client(runtime.videoObjectStorageConfig);
    const corsOrigin = 'https://player.example.test';
    const getObjectKey = `integration/signed-get-${randomUUID()}.txt`;
    const getBody = Buffer.from('signed GET through the public origin');
    await storage.putObject({
      objectKey: getObjectKey,
      body: getBody,
      contentType: 'text/plain',
    });

    await s3Client.send(
      new PutBucketCorsCommand({
        Bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [corsOrigin],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range'],
              MaxAgeSeconds: 300,
            },
          ],
        },
      }),
    );
    const corsConfiguration = await s3Client.send(
      new GetBucketCorsCommand({ Bucket: VIDEO_OBJECT_STORAGE_BUCKET }),
    );
    expect(corsConfiguration.CORSRules?.[0]?.AllowedOrigins).toEqual([corsOrigin]);

    const getUrl = await storage.getSignedUrl(getObjectKey);
    expect(new URL(getUrl).origin).toBe(runtime.objectStorageConfig.publicUrl);
    const getPreflight = await fetch(getUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: corsOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
      },
    });
    expect([200, 204]).toContain(getPreflight.status);
    // Garage cannot resolve S3-created local bucket aliases on unauthenticated OPTIONS
    // requests, so it deliberately answers these preflights permissively.
    expect(getPreflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(getPreflight.headers.get('access-control-allow-methods')).toBe('*');
    expect(getPreflight.headers.get('access-control-allow-headers')).toBe('*');

    const getResponse = await fetch(getUrl, { headers: { Origin: corsOrigin } });
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('access-control-allow-origin')).toBe(corsOrigin);
    expect(Buffer.from(await getResponse.arrayBuffer())).toEqual(getBody);

    const otherOriginResponse = await fetch(getUrl, {
      headers: { Origin: 'https://untrusted.example.test' },
    });
    expect(otherOriginResponse.status).toBe(200);
    expect(otherOriginResponse.headers.get('access-control-allow-origin')).toBeNull();

    const multipartObjectKey = `integration/signed-multipart-${randomUUID()}.bin`;
    const multipartBody = Buffer.from('signed multipart PUT through the public origin');
    const { uploadId } = await storage.initiateMultipartUpload({
      objectKey: multipartObjectKey,
      contentType: 'application/octet-stream',
    });
    const putUrl = await storage.signMultipartUploadPart({
      objectKey: multipartObjectKey,
      uploadId,
      partNumber: 1,
    });
    expect(new URL(putUrl).origin).toBe(runtime.objectStorageConfig.publicUrl);

    const putPreflight = await fetch(putUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: corsOrigin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect([200, 204]).toContain(putPreflight.status);
    expect(putPreflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(putPreflight.headers.get('access-control-allow-methods')).toBe('*');
    expect(putPreflight.headers.get('access-control-allow-headers')).toBe('*');

    const putResponse = await fetch(putUrl, {
      method: 'PUT',
      body: multipartBody,
      headers: { Origin: corsOrigin, 'Content-Type': 'application/octet-stream' },
    });
    expect(putResponse.status, await putResponse.clone().text()).toBe(200);
    expect(putResponse.headers.get('access-control-allow-origin')).toBe(corsOrigin);
    expect(putResponse.headers.get('access-control-expose-headers')).toContain('ETag');
    const etag = putResponse.headers.get('etag');

    if (!etag) {
      throw new Error('Multipart PUT response did not include an ETag');
    }

    await storage.completeMultipartUpload({
      objectKey: multipartObjectKey,
      uploadId,
      parts: [{ partNumber: 1, etag }],
    });

    const completedUrl = await storage.getSignedUrl(multipartObjectKey);
    const completedResponse = await fetch(completedUrl);
    expect(completedResponse.status).toBe(200);
    expect(Buffer.from(await completedResponse.arrayBuffer())).toEqual(multipartBody);
    s3Client.destroy();
  });
});
