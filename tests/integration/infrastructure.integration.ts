import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createExternalResourceReconciler } from '../../src/services/externalResources.js';
import { createPng } from './support/fixtures.js';
import { VIDEO_OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
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

  test('serves signed GETs and accepts signed multipart PUTs through the public MinIO origin', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const getObjectKey = `integration/signed-get-${randomUUID()}.txt`;
    const getBody = Buffer.from('signed GET through the public origin');
    await runtime.objectStorage.putObject({
      objectKey: getObjectKey,
      body: getBody,
      contentType: 'text/plain',
    });

    const getUrl = await runtime.objectStorage.getSignedUrl(getObjectKey);
    expect(new URL(getUrl).origin).toBe(runtime.objectStorageConfig.publicUrl);
    const getResponse = await fetch(getUrl);
    expect(getResponse.status).toBe(200);
    expect(Buffer.from(await getResponse.arrayBuffer())).toEqual(getBody);

    const multipartObjectKey = `integration/signed-multipart-${randomUUID()}.bin`;
    const multipartBody = Buffer.from('signed multipart PUT through the public origin');
    const { uploadId } = await runtime.objectStorage.initiateMultipartUpload({
      objectKey: multipartObjectKey,
      contentType: 'application/octet-stream',
    });
    const putUrl = await runtime.objectStorage.signMultipartUploadPart({
      objectKey: multipartObjectKey,
      uploadId,
      partNumber: 1,
    });
    expect(new URL(putUrl).origin).toBe(runtime.objectStorageConfig.publicUrl);

    const putResponse = await fetch(putUrl, {
      method: 'PUT',
      body: multipartBody,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag');

    if (!etag) {
      throw new Error('MinIO multipart PUT response did not include an ETag');
    }

    await runtime.objectStorage.completeMultipartUpload({
      objectKey: multipartObjectKey,
      uploadId,
      parts: [{ partNumber: 1, etag }],
    });

    const completedUrl = await runtime.objectStorage.getSignedUrl(multipartObjectKey);
    const completedResponse = await fetch(completedUrl);
    expect(completedResponse.status).toBe(200);
    expect(Buffer.from(await completedResponse.arrayBuffer())).toEqual(multipartBody);
  });
});
