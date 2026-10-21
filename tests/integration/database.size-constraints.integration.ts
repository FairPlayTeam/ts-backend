import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createVerifiedSession } from './support/fixtures.js';
import { resetState, startRuntime, stopRuntime, type TestRuntime } from './support/runtime.js';

describe('database size constraints', () => {
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

  test.each(['source', 'source_thumbnail', 'user_media'] as const)(
    'requires a positive non-null size for %s on insert and update',
    async (role) => {
      if (!runtime) {
        throw new Error('Integration runtime was not started');
      }

      const { userId } = await createVerifiedSession(runtime, {
        email: 'size-constraint@example.com',
        username: 'size_constraint',
      });
      const video = await runtime.prisma.video.create({
        data: { ownerId: userId, publicId: randomUUID(), title: 'Size constraint' },
      });
      const videoId = role === 'user_media' ? null : video.id;

      for (const size of [null, 0n, -1n]) {
        await expect(runtime.prisma.$executeRaw`
          INSERT INTO "external_resource_targets" (
            "id", "user_id", "video_id", "bucket", "selector", "selector_kind",
            "role", "generation", "expected_size_bytes", "updated_at"
          ) VALUES (
            CAST(${randomUUID()} AS UUID), CAST(${userId} AS UUID),
            CAST(${videoId} AS UUID), 'size-constraints', ${randomUUID()}, 'exact',
            CAST(${role} AS "ExternalResourceRole"), 'size-constraint',
            CAST(${size} AS BIGINT), CURRENT_TIMESTAMP
          )
        `).rejects.toThrow('external_resource_targets_expected_size_check');
      }

      const target = await runtime.prisma.externalResourceTarget.create({
        data: {
          userId,
          videoId,
          bucket: 'size-constraints',
          selector: randomUUID(),
          selectorKind: 'exact',
          role,
          generation: 'size-constraint',
          expectedSizeBytes: 1n,
        },
      });

      for (const size of [null, 0n, -1n]) {
        await expect(runtime.prisma.$executeRaw`
          UPDATE "external_resource_targets"
          SET "expected_size_bytes" = CAST(${size} AS BIGINT)
          WHERE "id" = CAST(${target.id} AS UUID)
        `).rejects.toThrow('external_resource_targets_expected_size_check');
      }

      await expect(
        runtime.prisma.externalResourceTarget.findUniqueOrThrow({
          where: { id: target.id },
          select: { expectedSizeBytes: true },
        }),
      ).resolves.toEqual({ expectedSizeBytes: 1n });
      await expect(runtime.prisma.externalResourceTarget.count()).resolves.toBe(1);
    },
  );

  test.each(['hls_artifacts', 'thumbnail_prefix'] as const)(
    'preserves the absent size for the %s prefix',
    async (role) => {
      if (!runtime) {
        throw new Error('Integration runtime was not started');
      }

      const { userId } = await createVerifiedSession(runtime, {
        email: 'prefix-size-constraint@example.com',
        username: 'prefix_size_check',
      });
      const video = await runtime.prisma.video.create({
        data: { ownerId: userId, publicId: randomUUID(), title: 'Prefix size constraint' },
      });
      const target = await runtime.prisma.externalResourceTarget.create({
        data: {
          userId,
          videoId: video.id,
          bucket: 'size-constraints',
          selector: `${randomUUID()}/`,
          selectorKind: 'prefix',
          role,
          generation: 'size-constraint',
        },
      });

      await expect(runtime.prisma.$executeRaw`
        UPDATE "external_resource_targets" SET "expected_size_bytes" = NULL
        WHERE "id" = CAST(${target.id} AS UUID)
      `).resolves.toBe(1);

      for (const size of [0n, -1n, 1n]) {
        await expect(runtime.prisma.$executeRaw`
          UPDATE "external_resource_targets"
          SET "expected_size_bytes" = ${size}
          WHERE "id" = CAST(${target.id} AS UUID)
        `).rejects.toThrow('external_resource_targets_expected_size_check');
      }

      await expect(
        runtime.prisma.externalResourceTarget.findUniqueOrThrow({
          where: { id: target.id },
          select: { expectedSizeBytes: true },
        }),
      ).resolves.toEqual({ expectedSizeBytes: null });
    },
  );

  test('requires a complete source with a positive non-null size on insert and update', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const { userId } = await createVerifiedSession(runtime, {
      email: 'video-size-constraint@example.com',
      username: 'video_size_check',
    });
    const video = await runtime.prisma.video.create({
      data: { ownerId: userId, publicId: randomUUID(), title: 'Source size constraint' },
    });
    expect(video).toMatchObject({
      sourceUploadSessionId: null,
      sourceObjectKey: null,
      sourceSizeBytes: null,
    });

    const expiresAt = new Date(Date.now() + 60_000);
    const objectKey = `${randomUUID()}/source.mp4`;
    const target = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId,
        videoId: video.id,
        bucket: 'size-constraints',
        selector: objectKey,
        selectorKind: 'exact',
        role: 'source',
        generation: 'size-constraint',
        expectedSizeBytes: 1n,
      },
    });
    const session = await runtime.prisma.videoUploadSession.create({
      data: {
        videoId: video.id,
        userId,
        bucket: 'size-constraints',
        objectKey,
        partSizeBytes: 1,
        expectedSizeBytes: 1n,
        expiresAt,
        hardExpiresAt: expiresAt,
        externalResourceTargetId: target.id,
      },
    });

    for (const size of [null, 0n, -1n]) {
      await expect(runtime.prisma.$executeRaw`
        INSERT INTO "videos" (
          "id", "public_id", "owner_id", "title", "source_upload_session_id",
          "source_object_key", "source_size_bytes", "updated_at"
        ) VALUES (
          CAST(${randomUUID()} AS UUID), ${randomUUID()}, CAST(${userId} AS UUID),
          'Invalid source size', CAST(${session.id} AS UUID), ${session.objectKey},
          CAST(${size} AS BIGINT), CURRENT_TIMESTAMP
        )
      `).rejects.toThrow('videos_source_fields_check');
    }

    await expect(runtime.prisma.$executeRaw`
      UPDATE "videos"
      SET "source_upload_session_id" = CAST(${session.id} AS UUID),
          "source_object_key" = ${session.objectKey}, "source_size_bytes" = 1
      WHERE "id" = CAST(${video.id} AS UUID)
    `).resolves.toBe(1);

    for (const size of [null, 0n, -1n]) {
      await expect(runtime.prisma.$executeRaw`
        UPDATE "videos" SET "source_size_bytes" = CAST(${size} AS BIGINT)
        WHERE "id" = CAST(${video.id} AS UUID)
      `).rejects.toThrow('videos_source_fields_check');
    }

    for (const fields of [
      { sessionId: null, objectKey: session.objectKey, size: 1n },
      { sessionId: session.id, objectKey: null, size: 1n },
      { sessionId: null, objectKey: null, size: 1n },
      { sessionId: session.id, objectKey: null, size: null },
      { sessionId: null, objectKey: session.objectKey, size: null },
    ]) {
      await expect(runtime.prisma.$executeRaw`
        UPDATE "videos"
        SET "source_upload_session_id" = CAST(${fields.sessionId} AS UUID),
            "source_object_key" = ${fields.objectKey},
            "source_size_bytes" = CAST(${fields.size} AS BIGINT)
        WHERE "id" = CAST(${video.id} AS UUID)
      `).rejects.toThrow('videos_source_fields_check');
    }

    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { sourceUploadSessionId: true, sourceObjectKey: true, sourceSizeBytes: true },
      }),
    ).resolves.toEqual({
      sourceUploadSessionId: session.id,
      sourceObjectKey: session.objectKey,
      sourceSizeBytes: 1n,
    });
    await expect(runtime.prisma.video.count()).resolves.toBe(1);

    await expect(runtime.prisma.$executeRaw`
      UPDATE "videos"
      SET "source_upload_session_id" = NULL, "source_object_key" = NULL, "source_size_bytes" = NULL
      WHERE "id" = CAST(${video.id} AS UUID)
    `).resolves.toBe(1);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { sourceUploadSessionId: true, sourceObjectKey: true, sourceSizeBytes: true },
      }),
    ).resolves.toEqual({
      sourceUploadSessionId: null,
      sourceObjectKey: null,
      sourceSizeBytes: null,
    });
  });
});
