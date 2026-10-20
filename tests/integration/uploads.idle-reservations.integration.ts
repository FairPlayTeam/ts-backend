import { Prisma, type PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../src/config/constants.js';
import { ObjectStorageUnavailableError, type ObjectStorage } from '../../src/lib/objectStorage.js';
import {
  createExternalResourceReconciler,
  EXTERNAL_RESOURCE_QUIESCENCE_MS,
} from '../../src/services/externalResources.js';
import {
  createVideoUploadsReconciliationHandlers,
  createVideoUploadsService,
} from '../../src/modules/videoUploads/index.js';
import {
  VideoTranscodeAdmissionFullError,
  VideoUploadSessionExpiredError,
} from '../../src/modules/videoUploads/errors.js';
import { createPng, createVerifiedSession } from './support/fixtures.js';
import { waitForBarrier } from './support/asyncBarriers.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  createIntegrationApp,
  createIntegrationVideoUploadsDependencies,
  createPostgresApplicationName,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

describe('durable idle upload reservations', () => {
  let runtime: TestRuntime;
  let now: Date;
  beforeAll(async () => {
    runtime = await startRuntime();
  });
  beforeEach(async () => {
    await resetState(runtime);
    now = new Date();
  });
  afterAll(async () => {
    await stopRuntime(runtime);
  });

  const makeService = (
    config: Parameters<typeof createIntegrationVideoUploadsDependencies>[3] = {},
    storage: ObjectStorage = runtime.videoObjectStorage,
    prisma: PrismaClient = runtime.prisma,
  ) => {
    const resources = createExternalResourceReconciler({
      prisma,
      objectStorage: storage,
      clock: { now: () => now },
      logger: testLogger,
    });
    const deps = createIntegrationVideoUploadsDependencies(prisma, storage, resources, {
      ...config,
      now: () => now,
    });
    return {
      service: createVideoUploadsService(deps),
      resources,
      handlers: createVideoUploadsReconciliationHandlers(deps),
    };
  };
  const owner = (suffix = 'owner') =>
    createVerifiedSession(runtime, {
      email: `idle-policy-${suffix}@example.com`,
      username: `idle_policy_${suffix}`,
    });
  const video = async (userId: string, title = 'Idle policy') =>
    (
      await runtime.videosService.createVideo({
        userId,
        title,
        tags: [],
        license: 'cc0',
        allowComments: true,
      })
    ).video;
  const put = async (url: string | undefined, body: Buffer) => {
    if (!url) throw new Error('Missing signed part URL');
    const response = await fetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(5000) });
    await response.text();
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('Missing real storage ETag');
    return etag;
  };
  const holdRow = (table: 'users' | 'video_upload_sessions', id: string) => {
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operation = runtime.prisma.$transaction(
      async (tx) => {
        if (table === 'users') {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "users" WHERE "id" = CAST(${id} AS UUID) FOR UPDATE`,
          );
        } else {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "video_upload_sessions" WHERE "id" = CAST(${id} AS UUID) FOR UPDATE`,
          );
        }
        acquired.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    return { operation, acquired: acquired.promise, release: release.resolve };
  };

  test('recovers ten idle slots on admission and prevents the same five accounts from refilling them', async () => {
    const policy = makeService();
    const app = await createIntegrationApp(runtime, { videoUploadsService: policy.service });
    const attempts: { publicId: string; key: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const actor = await owner(`attack${i}`);
      for (let j = 0; j < 2; j += 1) {
        const created = await video(actor.userId);
        const response = await request(app)
          .post(`/videos/${created.publicId}/upload/multipart/init`)
          .set('Authorization', `Bearer ${actor.sessionKey}`)
          .send({ sizeBytes: 1 })
          .expect(201);
        expect(new Date(response.body.uploadSession.expiresAt).getTime()).toBe(
          now.getTime() + 15 * MINUTE_MS,
        );
        expect(response.body.uploadSession).not.toHaveProperty('hardExpiresAt');
        expect(response.body.uploadSession).not.toHaveProperty('verifiedUploadedBytes');
        expect(response.body.uploadSession).not.toHaveProperty('nextProgressCheckAt');
        attempts.push({ publicId: created.publicId, key: actor.sessionKey });
      }
    }
    const sessions = await runtime.prisma.videoUploadSession.findMany({
      include: { multipartHandle: true },
    });
    for (const session of sessions) {
      if (!session.multipartHandle) throw new Error('Missing multipart handle');
      expect(
        (
          await runtime.videoObjectStorage.listMultipartUploadParts({
            bucket: session.bucket,
            objectKey: session.objectKey,
            uploadId: session.multipartHandle.uploadId,
            limit: 1,
          })
        ).parts,
      ).toEqual([]);
    }
    const victim = await owner('victim');
    const created = await video(victim.userId);
    const init = () =>
      request(app)
        .post(`/videos/${created.publicId}/upload/multipart/init`)
        .set('Authorization', `Bearer ${victim.sessionKey}`)
        .send({ sizeBytes: 1 });
    const full = await init().expect(429);
    now = new Date(now.getTime() + 15 * MINUTE_MS + 1);
    await init().expect(201); // No maintenance call: admission commits the durable expiration itself.
    expect(await runtime.prisma.videoUploadSession.count({ where: { status: 'expiring' } })).toBe(
      10,
    );
    expect(
      await runtime.prisma.externalResourceTarget.count({
        where: { role: 'source', goal: 'absent', state: 'quiescing' },
      }),
    ).toBe(10);
    for (const attempt of attempts) {
      const limited = await request(app)
        .post(`/videos/${attempt.publicId}/upload/multipart/init`)
        .set('Authorization', `Bearer ${attempt.key}`)
        .send({ sizeBytes: 1 })
        .expect(429);
      expect(limited.body).toEqual(full.body);
    }
    expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
  });

  test('abort, video deletion and confirmed cleanup do not refund the rolling creation budget', async () => {
    const actor = await owner();
    const policy = makeService();
    for (let i = 0; i < 2; i += 1) {
      const created = await video(actor.userId);
      const input = { userId: actor.userId, videoId: created.id };
      const reserved = await policy.service.initMultipartUpload({ ...input, sizeBytes: 1 });
      await policy.service.abortMultipartUpload({
        ...input,
        uploadSessionId: reserved.uploadSession.id,
      });
      await runtime.videosService.deleteVideo({ userId: actor.userId, publicId: created.publicId });
    }
    expect(await runtime.prisma.videoUploadSession.count()).toBe(0);
    const created = await video(actor.userId);
    await expect(
      policy.service.initMultipartUpload({
        userId: actor.userId,
        videoId: created.id,
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(VideoTranscodeAdmissionFullError);
    const cleanup = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date(now.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS + MINUTE_MS) },
      logger: testLogger,
    });
    expect(
      await cleanup.reconcileDue({ roles: ['source'], limit: 10, handlers: policy.handlers }),
    ).toMatchObject({ confirmed: 2, failed: 0 });
    await expect(
      policy.service.initMultipartUpload({
        userId: actor.userId,
        videoId: created.id,
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(VideoTranscodeAdmissionFullError);
    expect(
      await runtime.prisma.externalResourceTarget.count({
        where: { role: 'source', state: 'confirmed_absent' },
      }),
    ).toBe(2);
    now = new Date(now.getTime() + HOUR_MS + 1);
    await expect(
      policy.service.initMultipartUpload({
        userId: actor.userId,
        videoId: created.id,
        sizeBytes: 1,
      }),
    ).resolves.toMatchObject({ uploadSession: { status: 'initiated' } });
  });

  test('only newly observed conforming source bytes renew the reservation, within its hard deadline', async () => {
    const actor = await owner();
    const partSize = 5 * 1024 * 1024;
    const base = now.getTime();
    const policy = makeService({ partSizeBytes: partSize, sessionTtlSeconds: 20 * 60 });
    const created = await video(actor.userId);
    const input = { userId: actor.userId, videoId: created.id };
    const reserved = await policy.service.initMultipartUpload({
      ...input,
      sizeBytes: partSize + 7,
    });
    const signInput = { ...input, uploadSessionId: reserved.uploadSession.id, partNumbers: [1, 2] };
    const signed = await policy.service.signMultipartUploadParts(signInput);
    expect(signed.expiresAt.getTime()).toBe(base + 15 * MINUTE_MS);
    now = new Date(base + MINUTE_MS);
    await put(signed.parts[0]?.url, Buffer.alloc(partSize, 1));
    const renewed = await policy.service.signMultipartUploadParts(signInput);
    expect(renewed.expiresAt.getTime()).toBe(base + 16 * MINUTE_MS);
    now = new Date(base + 2 * MINUTE_MS);
    await put(signed.parts[0]?.url, Buffer.alloc(partSize, 2));
    expect((await policy.service.signMultipartUploadParts(signInput)).expiresAt).toEqual(
      renewed.expiresAt,
    );
    now = new Date(base + 3 * MINUTE_MS);
    await put(signed.parts[1]?.url, Buffer.alloc(8)); // Wrong last-part size cannot buy time.
    expect((await policy.service.signMultipartUploadParts(signInput)).expiresAt).toEqual(
      renewed.expiresAt,
    );
    now = new Date(base + 14 * MINUTE_MS);
    await put(signed.parts[1]?.url, Buffer.alloc(7));
    const capped = await policy.service.signMultipartUploadParts(signInput);
    expect(capped.expiresAt.getTime()).toBe(base + 20 * MINUTE_MS);
    const persisted = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
      where: { id: reserved.uploadSession.id },
    });
    expect(persisted.verifiedUploadedBytes).toBe(BigInt(partSize + 7));
    expect(persisted.hardExpiresAt).toEqual(capped.expiresAt);
  });

  test.each([900, 60])(
    'HTTP renewal observes a real part at T-5 after an empty T-10 check (idle TTL %i s)',
    async (idleTtlSeconds) => {
      const actor = await owner();
      let reads = 0;
      const storage: ObjectStorage = {
        ...runtime.videoObjectStorage,
        listMultipartUploadParts: async (input) => {
          reads += 1;
          return runtime.videoObjectStorage.listMultipartUploadParts(input);
        },
      };
      const policy = makeService({ idleTtlSeconds }, storage);
      const app = await createIntegrationApp(runtime, { videoUploadsService: policy.service });
      const created = await video(actor.userId);
      const auth = `Bearer ${actor.sessionKey}`;
      const initialized = await request(app)
        .post(`/videos/${created.publicId}/upload/multipart/init`)
        .set('Authorization', auth)
        .send({ sizeBytes: 1 })
        .expect(201);
      const sessionId: unknown = initialized.body.uploadSession.id;
      if (typeof sessionId !== 'string') throw new Error('Missing HTTP session id');
      const deadline = new Date(initialized.body.uploadSession.expiresAt).getTime();
      const sign = () =>
        request(app)
          .post(`/videos/${created.publicId}/upload/multipart/${sessionId}/parts/sign`)
          .set('Authorization', auth)
          .send({ partNumbers: [1] });
      now = new Date(deadline - 10_000);
      const empty = await sign().expect(200);
      expect(reads).toBe(1);
      expect(new Date(empty.body.expiresAt).getTime()).toBe(deadline);
      await put(empty.body.parts[0]?.url, Buffer.from('x'));
      const session = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: sessionId },
        include: { multipartHandle: true },
      });
      if (!session.multipartHandle) throw new Error('Missing real upload handle');
      expect(
        (
          await runtime.videoObjectStorage.listMultipartUploadParts({
            objectKey: session.objectKey,
            uploadId: session.multipartHandle.uploadId,
            limit: 1,
          })
        ).parts,
      ).toEqual([{ partNumber: 1, sizeBytes: 1 }]);
      now = new Date(deadline - 5_000);
      const renewed = await sign().expect(200);
      expect(reads).toBe(2);
      expect(new Date(renewed.body.expiresAt).getTime()).toBe(
        now.getTime() + idleTtlSeconds * 1000,
      );
      expect(
        (await runtime.prisma.videoUploadSession.findUniqueOrThrow({ where: { id: sessionId } }))
          .verifiedUploadedBytes,
      ).toBe(1n);
      expect(Object.keys(renewed.body).sort()).toEqual(['expiresAt', 'parts', 'uploadSessionId']);
    },
  );

  test.each(['wrong-size', 'unavailable'])(
    'late polling keeps a five-second floor without free renewal or post-expiry recovery (%s)',
    async (scenario) => {
      const actor = await owner();
      let reads = 0;
      let fail = false;
      const storage: ObjectStorage = {
        ...runtime.videoObjectStorage,
        listMultipartUploadParts: async (input) => {
          reads += 1;
          if (fail) throw new ObjectStorageUnavailableError();
          return runtime.videoObjectStorage.listMultipartUploadParts(input);
        },
      };
      const policy = makeService({}, storage);
      const created = await video(actor.userId);
      const input = { userId: actor.userId, videoId: created.id };
      const reserved = await policy.service.initMultipartUpload({ ...input, sizeBytes: 1 });
      const signInput = { ...input, uploadSessionId: reserved.uploadSession.id, partNumbers: [1] };
      const deadline = reserved.uploadSession.expiresAt.getTime();
      now = new Date(deadline - 10_000);
      const initial = await policy.service.signMultipartUploadParts(signInput);
      await put(initial.parts[0]?.url, Buffer.alloc(2)); // Incorrect size cannot renew.
      for (let remaining = 9_000; remaining > 5_000; remaining -= 1_000) {
        now = new Date(deadline - remaining);
        expect((await policy.service.signMultipartUploadParts(signInput)).expiresAt).toEqual(
          reserved.uploadSession.expiresAt,
        );
      }
      expect(reads).toBe(1);
      now = new Date(deadline - 5_000);
      fail = scenario === 'unavailable';
      if (fail) {
        await expect(policy.service.signMultipartUploadParts(signInput)).rejects.toBeInstanceOf(
          ObjectStorageUnavailableError,
        );
      } else {
        expect((await policy.service.signMultipartUploadParts(signInput)).expiresAt).toEqual(
          reserved.uploadSession.expiresAt,
        );
      }
      expect(reads).toBe(2);
      // An unavailable observation consumes its interval; a retry cannot buy free storage reads/time.
      fail = false;
      await put(initial.parts[0]?.url, Buffer.from('x'));
      for (let remaining = 4_000; remaining > 0; remaining -= 1_000) {
        now = new Date(deadline - remaining);
        expect((await policy.service.signMultipartUploadParts(signInput)).expiresAt).toEqual(
          reserved.uploadSession.expiresAt,
        );
      }
      expect(reads).toBe(2);
      const persisted = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reserved.uploadSession.id },
      });
      expect(persisted.verifiedUploadedBytes).toBe(0n);
      expect(persisted.expiresAt).toEqual(reserved.uploadSession.expiresAt);
      now = new Date(deadline);
      await expect(policy.service.signMultipartUploadParts(signInput)).rejects.toBeInstanceOf(
        VideoUploadSessionExpiredError,
      );
      expect(reads).toBe(2);
    },
  );

  test('concurrent late checks share one persisted observation after real PostgreSQL lock waits', async () => {
    const actor = await owner();
    const created = await video(actor.userId);
    const snapshots: Awaited<ReturnType<ObjectStorage['listMultipartUploadParts']>>[] = [];
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      listMultipartUploadParts: async (input) => {
        const result = await runtime.videoObjectStorage.listMultipartUploadParts(input);
        snapshots.push(result);
        return result;
      },
    };
    const names: [string, string] = [
      createPostgresApplicationName(),
      createPostgresApplicationName(),
    ];
    const clients = names.map((applicationName) =>
      createPrismaClient(runtime.databaseUrl, { applicationName }),
    );
    const services = clients.map((client) => makeService({}, storage, client).service);
    const first = services[0];
    if (!first) throw new Error('Missing service');
    const input = { userId: actor.userId, videoId: created.id };
    const reserved = await first.initMultipartUpload({ ...input, sizeBytes: 1 });
    now = new Date(reserved.uploadSession.expiresAt.getTime() - 10_000);
    const gate = holdRow('video_upload_sessions', reserved.uploadSession.id);
    const operations: Promise<unknown>[] = [];
    try {
      await waitForBarrier({
        description: 'session locked before competing late checks',
        signal: gate.acquired,
        operations: [gate.operation],
      });
      operations.push(
        ...services.map((service) =>
          service.signMultipartUploadParts({
            ...input,
            uploadSessionId: reserved.uploadSession.id,
            partNumbers: [1],
          }),
        ),
      );
      operations.forEach((operation) => {
        void operation.catch(() => undefined);
      });
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: names,
        expectedCount: 2,
        queryFragments: ['video_upload_sessions', 'FOR UPDATE'],
      });
      gate.release();
      await gate.operation;
      await Promise.all(operations);
      expect(snapshots).toEqual([{ parts: [], truncated: false }]);
      for (const service of services) {
        expect(
          (
            await service.signMultipartUploadParts({
              ...input,
              uploadSessionId: reserved.uploadSession.id,
              partNumbers: [1],
            })
          ).expiresAt,
        ).toEqual(reserved.uploadSession.expiresAt);
      }
      expect(snapshots).toHaveLength(1);
    } finally {
      gate.release();
      await Promise.allSettled([gate.operation, ...operations]);
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  test('signature polling is bounded and a failed progress read cannot extend the reservation', async () => {
    const actor = await owner();
    let reads = 0;
    let fail = false;
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      listMultipartUploadParts: async (input) => {
        reads += 1;
        if (fail) throw new ObjectStorageUnavailableError();
        return runtime.videoObjectStorage.listMultipartUploadParts(input);
      },
    };
    const policy = makeService({}, storage);
    const created = await video(actor.userId);
    const input = { userId: actor.userId, videoId: created.id };
    const reserved = await policy.service.initMultipartUpload({ ...input, sizeBytes: 1 });
    const signInput = { ...input, uploadSessionId: reserved.uploadSession.id, partNumbers: [1] };
    for (let i = 0; i < 5; i += 1) {
      const signed = await policy.service.signMultipartUploadParts(signInput);
      expect(signed.expiresAt).toEqual(reserved.uploadSession.expiresAt);
      const ttl = Number(new URL(signed.parts[0]?.url ?? '').searchParams.get('X-Amz-Expires'));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    }
    expect(reads).toBe(1);
    fail = true;
    now = new Date(now.getTime() + MINUTE_MS);
    await expect(policy.service.signMultipartUploadParts(signInput)).rejects.toBeInstanceOf(
      ObjectStorageUnavailableError,
    );
    expect(
      (
        await policy.service.getMultipartUploadSession({
          ...input,
          uploadSessionId: reserved.uploadSession.id,
        })
      ).uploadSession.expiresAt,
    ).toEqual(reserved.uploadSession.expiresAt);
  });

  test('a delayed real progress snapshot cannot revive an expired reservation or publish its old source', async () => {
    const actor = await owner();
    const fetched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delay = false;
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      listMultipartUploadParts: async (input) => {
        const result = await runtime.videoObjectStorage.listMultipartUploadParts(input);
        if (delay) {
          fetched.resolve();
          await release.promise;
        }
        return result;
      },
    };
    const policy = makeService({ maxTranscodeOutstandingJobs: 1 }, storage);
    const created = await video(actor.userId);
    const input = { userId: actor.userId, videoId: created.id };
    const reserved = await policy.service.initMultipartUpload({ ...input, sizeBytes: 1 });
    const signInput = { ...input, uploadSessionId: reserved.uploadSession.id, partNumbers: [1] };
    const signed = await policy.service.signMultipartUploadParts(signInput);
    const etag = await put(signed.parts[0]?.url, Buffer.from('x'));
    now = new Date(now.getTime() + MINUTE_MS);
    delay = true;
    const pending = policy.service.signMultipartUploadParts(signInput);
    void pending.catch(() => undefined);
    try {
      await waitForBarrier({
        description: 'actual S3 progress fetched',
        signal: fetched.promise,
        operations: [pending],
      });
      now = new Date(reserved.uploadSession.expiresAt.getTime() + 1);
      const nextVideo = await video(actor.userId);
      await policy.service.initMultipartUpload({
        userId: actor.userId,
        videoId: nextVideo.id,
        sizeBytes: 1,
      });
      release.resolve();
      await expect(pending).rejects.toBeInstanceOf(VideoUploadSessionExpiredError);
      await expect(
        policy.service.completeMultipartUpload({
          ...input,
          uploadSessionId: reserved.uploadSession.id,
          parts: [{ partNumber: 1, etag }],
        }),
      ).rejects.toBeInstanceOf(VideoUploadSessionExpiredError);
      const old = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reserved.uploadSession.id },
        include: { externalResourceTarget: true },
      });
      expect(old.status).toBe('expiring');
      expect(old.verifiedUploadedBytes).toBe(0n);
      expect(old.externalResourceTarget.goal).toBe('absent');
      expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
      await put(signed.parts[0]?.url, Buffer.from('y')); // The app deadline alone does not revoke S3.
      now = new Date(now.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS + 1);
      await policy.resources.reconcileTarget({
        targetId: old.externalResourceTargetId,
        roles: ['source'],
        handlers: policy.handlers,
      });
      const replay = await fetch(signed.parts[0]?.url ?? '', {
        method: 'PUT',
        body: Buffer.from('z'),
      });
      await replay.text();
      expect(replay.status).toBe(404);
      expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  test('fresh expiry after a real row-lock wait prevents publication and double allocation', async () => {
    const actor = await owner();
    const first = await video(actor.userId, 'old');
    const second = await video(actor.userId, 'new');
    const names: [string, string] = [
      createPostgresApplicationName(),
      createPostgresApplicationName(),
    ];
    const clients = names.map((applicationName) =>
      createPrismaClient(runtime.databaseUrl, { applicationName }),
    );
    const [firstClient, secondClient] = clients;
    if (!firstClient || !secondClient) throw new Error('Missing test clients');
    const config = { maxTranscodeOutstandingJobs: 1, maxTranscodeOutstandingJobsPerUser: 1 };
    const old = makeService(config, runtime.videoObjectStorage, firstClient);
    const next = makeService(config, runtime.videoObjectStorage, secondClient);
    const input = { userId: actor.userId, videoId: first.id };
    const reserved = await old.service.initMultipartUpload({ ...input, sizeBytes: 1 });
    const signed = await old.service.signMultipartUploadParts({
      ...input,
      uploadSessionId: reserved.uploadSession.id,
      partNumbers: [1],
    });
    const etag = await put(signed.parts[0]?.url, Buffer.from('x'));
    const gate = holdRow('video_upload_sessions', reserved.uploadSession.id);
    const operations: Promise<unknown>[] = [];
    try {
      await waitForBarrier({
        description: 'actual session lock acquired',
        signal: gate.acquired,
        operations: [gate.operation],
      });
      const completing = old.service.completeMultipartUpload({
        ...input,
        uploadSessionId: reserved.uploadSession.id,
        parts: [{ partNumber: 1, etag }],
      });
      void completing.catch(() => undefined);
      operations.push(completing);
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: [names[0]],
        expectedCount: 1,
        queryFragments: ['video_upload_sessions', 'FOR UPDATE'],
      });
      now = new Date(reserved.uploadSession.expiresAt.getTime() + 1);
      const admitting = next.service.initMultipartUpload({
        userId: actor.userId,
        videoId: second.id,
        sizeBytes: 1,
      });
      void admitting.catch(() => undefined);
      operations.push(admitting);
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: [names[1]],
        expectedCount: 1,
        queryFragments: ['video_upload_sessions', 'FOR UPDATE'],
      });
      gate.release();
      await gate.operation;
      await expect(completing).rejects.toBeInstanceOf(VideoUploadSessionExpiredError);
      await expect(admitting).resolves.toMatchObject({ uploadSession: { status: 'initiated' } });
      expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
      expect(
        await runtime.prisma.videoUploadSession.count({
          where: { status: { in: ['initializing', 'initiated', 'uploading', 'completing'] } },
        }),
      ).toBe(1);
    } finally {
      gate.release();
      await Promise.allSettled([gate.operation, ...operations]);
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  test('a late multipart initialization response stays tracked after durable expiry', async () => {
    const actor = await owner();
    const created = await video(actor.userId);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      initiateMultipartUpload: async (input) => {
        const result = await runtime.videoObjectStorage.initiateMultipartUpload(input);
        started.resolve();
        await release.promise;
        return result;
      },
    };
    const policy = makeService({ maxTranscodeOutstandingJobs: 1 }, storage);
    const pending = policy.service.initMultipartUpload({
      userId: actor.userId,
      videoId: created.id,
      sizeBytes: 1,
    });
    void pending.catch(() => undefined);
    try {
      await waitForBarrier({
        description: 'actual multipart initialized before delayed return',
        signal: started.promise,
        operations: [pending],
      });
      const session = await runtime.prisma.videoUploadSession.findFirstOrThrow();
      now = new Date(session.expiresAt.getTime() + 1);
      expect(
        (await policy.service.expireMultipartUploadSessions({ expiredBefore: now }))
          .uploadSessionsExpired,
      ).toBe(1);
      release.resolve();
      await expect(pending).rejects.toBeInstanceOf(Error);
      const old = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(old.status).toBe('expiring');
      expect(
        await runtime.prisma.externalMultipartHandle.count({
          where: { targetId: old.externalResourceTargetId },
        }),
      ).toBe(1);
      now = new Date(now.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS + 1);
      await policy.resources.reconcileTarget({
        targetId: old.externalResourceTargetId,
        roles: ['source'],
        handlers: policy.handlers,
      });
      expect(
        await runtime.prisma.externalMultipartHandle.count({
          where: { targetId: old.externalResourceTargetId },
        }),
      ).toBe(0);
      expect(
        (
          await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
            where: { id: old.externalResourceTargetId },
          })
        ).state,
      ).toBe('confirmed_absent');
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  test('a multipart creation after confirmed cleanup reopens durable absence even after video deletion', async () => {
    const actor = await owner();
    const created = await video(actor.userId);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      initiateMultipartUpload: async (input) => {
        started.resolve();
        await release.promise;
        return runtime.videoObjectStorage.initiateMultipartUpload(input);
      },
    };
    const policy = makeService({}, storage);
    const pending = policy.service.initMultipartUpload({
      userId: actor.userId,
      videoId: created.id,
      sizeBytes: 1,
    });
    void pending.catch(() => undefined);
    try {
      await waitForBarrier({
        description: 'provider initiation delayed before its side effect',
        signal: started.promise,
        operations: [pending],
      });
      const session = await runtime.prisma.videoUploadSession.findFirstOrThrow();
      now = new Date(session.expiresAt.getTime() + 1);
      await policy.service.expireMultipartUploadSessions({ expiredBefore: now });
      await runtime.videosService.deleteVideo({ userId: actor.userId, publicId: created.publicId });
      now = new Date(now.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS + MINUTE_MS);
      await policy.resources.reconcileTarget({
        targetId: session.externalResourceTargetId,
        roles: ['source'],
        handlers: policy.handlers,
      });
      expect(
        (
          await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
            where: { id: session.externalResourceTargetId },
          })
        ).state,
      ).toBe('confirmed_absent');
      release.resolve();
      await expect(pending).rejects.toBeInstanceOf(Error);
      const target = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: session.externalResourceTargetId },
      });
      expect(target).toMatchObject({ goal: 'absent', state: 'quiescing' });
      expect(
        await runtime.prisma.externalMultipartHandle.count({
          where: { targetId: target.id, uploadSessionId: null },
        }),
      ).toBe(1);
      expect(
        (await storage.listMultipartUploads({ prefix: target.selector, limit: 2 })).uploads,
      ).toHaveLength(1);
      expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
      now = new Date(now.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS + 1);
      await policy.resources.reconcileTarget({
        targetId: target.id,
        roles: ['source'],
        handlers: policy.handlers,
      });
      expect(
        (await storage.listMultipartUploads({ prefix: target.selector, limit: 2 })).uploads,
      ).toEqual([]);
      expect(
        (
          await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
            where: { id: target.id },
          })
        ).state,
      ).toBe('confirmed_absent');
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  test('a late thumbnail PUT after confirmed cleanup reopens the same durable target', async () => {
    const actor = await owner();
    const created = await video(actor.userId);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      putObject: async (input) => {
        started.resolve();
        await release.promise;
        return runtime.videoObjectStorage.putObject(input);
      },
    };
    const policy = makeService({}, storage);
    const reserved = await policy.service.initMultipartUpload({
      userId: actor.userId,
      videoId: created.id,
      sizeBytes: 1,
    });
    const image = await createPng(64, 64);
    const pending = policy.service.uploadSourceThumbnail({
      userId: actor.userId,
      videoId: created.id,
      uploadSessionId: reserved.uploadSession.id,
      file: { buffer: image, size: image.length },
    });
    void pending.catch(() => undefined);
    try {
      await waitForBarrier({
        description: 'thumbnail PUT delayed before storage write',
        signal: started.promise,
        operations: [pending],
      });
      const target = await runtime.prisma.externalResourceTarget.findFirstOrThrow({
        where: { role: 'source_thumbnail' },
      });
      await runtime.videosService.deleteVideo({ userId: actor.userId, publicId: created.publicId });
      now = new Date(now.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS + MINUTE_MS);
      await policy.resources.reconcileTarget({
        targetId: target.id,
        roles: ['source_thumbnail'],
        handlers: policy.handlers,
      });
      expect(
        (
          await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
            where: { id: target.id },
          })
        ).state,
      ).toBe('confirmed_absent');
      release.resolve();
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(await storage.headObject({ objectKey: target.selector })).not.toBeNull();
      expect(
        (
          await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
            where: { id: target.id },
          })
        ).state,
      ).toBe('quiescing');
      expect(await runtime.prisma.videoSourceThumbnail.count()).toBe(0);
      now = new Date(now.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS + 1);
      await policy.resources.reconcileTarget({
        targetId: target.id,
        roles: ['source_thumbnail'],
        handlers: policy.handlers,
      });
      expect(await storage.headObject({ objectKey: target.selector })).toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  test('overlapping real snapshots spend newly observed bytes only once', async () => {
    const actor = await owner();
    const created = await video(actor.userId);
    const firstFetched = Promise.withResolvers<void>();
    const secondFetched = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    let delay = false;
    const delayedStorage = (
      fetched: typeof firstFetched,
      release: typeof firstRelease,
    ): ObjectStorage => ({
      ...runtime.videoObjectStorage,
      listMultipartUploadParts: async (input) => {
        const result = await runtime.videoObjectStorage.listMultipartUploadParts(input);
        if (delay) {
          fetched.resolve();
          await release.promise;
        }
        return result;
      },
    });
    const name = createPostgresApplicationName();
    const client = createPrismaClient(runtime.databaseUrl, { applicationName: name });
    const first = makeService({}, delayedStorage(firstFetched, firstRelease), client);
    const second = makeService({}, delayedStorage(secondFetched, secondRelease));
    const input = { userId: actor.userId, videoId: created.id };
    const reserved = await first.service.initMultipartUpload({ ...input, sizeBytes: 1 });
    const signInput = { ...input, uploadSessionId: reserved.uploadSession.id, partNumbers: [1] };
    const initial = await first.service.signMultipartUploadParts(signInput);
    await put(initial.parts[0]?.url, Buffer.from('x'));
    delay = true;
    now = new Date(now.getTime() + MINUTE_MS);
    const firstPending = first.service.signMultipartUploadParts(signInput);
    void firstPending.catch(() => undefined);
    let secondPending: ReturnType<typeof second.service.signMultipartUploadParts> | null = null;
    let gate: ReturnType<typeof holdRow> | null = null;
    try {
      await waitForBarrier({
        description: 'first actual progress snapshot',
        signal: firstFetched.promise,
        operations: [firstPending],
      });
      now = new Date(now.getTime() + MINUTE_MS);
      secondPending = second.service.signMultipartUploadParts(signInput);
      void secondPending.catch(() => undefined);
      await waitForBarrier({
        description: 'second actual overlapping snapshot',
        signal: secondFetched.promise,
        operations: [secondPending],
      });
      gate = holdRow('video_upload_sessions', reserved.uploadSession.id);
      await waitForBarrier({
        description: 'session lock before applying first snapshot',
        signal: gate.acquired,
        operations: [gate.operation],
      });
      firstRelease.resolve();
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: [name],
        expectedCount: 1,
        queryFragments: ['video_upload_sessions', 'FOR UPDATE'],
      });
      gate.release();
      await gate.operation;
      const renewed = await firstPending;
      now = new Date(now.getTime() + MINUTE_MS);
      secondRelease.resolve();
      expect((await secondPending).expiresAt).toEqual(renewed.expiresAt);
      expect(
        (
          await runtime.prisma.videoUploadSession.findUniqueOrThrow({
            where: { id: reserved.uploadSession.id },
          })
        ).verifiedUploadedBytes,
      ).toBe(1n);
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      gate?.release();
      await Promise.allSettled([
        firstPending,
        ...(secondPending ? [secondPending] : []),
        ...(gate ? [gate.operation] : []),
      ]);
      await client.$disconnect();
    }
  });

  test('thumbnail finalization rereads expiry after a real session lock wait', async () => {
    const actor = await owner();
    const created = await video(actor.userId);
    const fetched = Promise.withResolvers<void>();
    const releaseHead = Promise.withResolvers<void>();
    const name = createPostgresApplicationName();
    const client = createPrismaClient(runtime.databaseUrl, { applicationName: name });
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      headObject: async (input) => {
        const result = await runtime.videoObjectStorage.headObject(input);
        fetched.resolve();
        await releaseHead.promise;
        return result;
      },
    };
    // Expire while the finalizer waits, without also expiring its reconciliation lease.
    const policy = makeService({ idleTtlSeconds: 5 }, storage, client);
    const input = { userId: actor.userId, videoId: created.id };
    const reserved = await policy.service.initMultipartUpload({ ...input, sizeBytes: 1 });
    const image = await createPng(64, 64);
    const pending = policy.service.uploadSourceThumbnail({
      ...input,
      uploadSessionId: reserved.uploadSession.id,
      file: { buffer: image, size: image.length },
    });
    void pending.catch(() => undefined);
    let gate: ReturnType<typeof holdRow> | null = null;
    try {
      await waitForBarrier({
        description: 'actual thumbnail HEAD before finalization',
        signal: fetched.promise,
        operations: [pending],
      });
      gate = holdRow('video_upload_sessions', reserved.uploadSession.id);
      await waitForBarrier({
        description: 'session lock before thumbnail finalization',
        signal: gate.acquired,
        operations: [gate.operation],
      });
      releaseHead.resolve();
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: [name],
        expectedCount: 1,
        queryFragments: ['video_upload_sessions', 'FOR UPDATE'],
      });
      now = new Date(reserved.uploadSession.expiresAt.getTime() + 1);
      gate.release();
      await gate.operation;
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(await runtime.prisma.videoSourceThumbnail.count()).toBe(0);
      expect(
        await runtime.prisma.externalResourceTarget.count({
          where: { role: 'source_thumbnail', goal: 'absent' },
        }),
      ).toBe(1);
    } finally {
      releaseHead.resolve();
      gate?.release();
      await Promise.allSettled([pending, ...(gate ? [gate.operation] : [])]);
      await client.$disconnect();
    }
  });

  test('a ban during a real progress observation prevents renewal and preserves the response whitelist', async () => {
    const actor = await owner();
    const fetched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delay = false;
    const storage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      listMultipartUploadParts: async (input) => {
        const result = await runtime.videoObjectStorage.listMultipartUploadParts(input);
        if (delay) {
          fetched.resolve();
          await release.promise;
        }
        return result;
      },
    };
    const policy = makeService({}, storage);
    const app = await createIntegrationApp(runtime, { videoUploadsService: policy.service });
    const created = await video(actor.userId);
    const reserved = await policy.service.initMultipartUpload({
      userId: actor.userId,
      videoId: created.id,
      sizeBytes: 1,
    });
    const path = `/videos/${created.publicId}/upload/multipart/${reserved.uploadSession.id}/parts/sign`;
    const response = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${actor.sessionKey}`)
      .send({ partNumbers: [1] })
      .expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['expiresAt', 'parts', 'uploadSessionId']);
    expect(Object.keys(response.body.parts[0]).sort()).toEqual(['partNumber', 'url']);
    await put(response.body.parts[0].url, Buffer.from('x'));
    now = new Date(now.getTime() + MINUTE_MS);
    delay = true;
    const pending = request(app)
      .post(path)
      .set('Authorization', `Bearer ${actor.sessionKey}`)
      .send({ partNumbers: [1] })
      .then((result) => result);
    try {
      await waitForBarrier({
        description: 'real progress response before account ban',
        signal: fetched.promise,
        operations: [pending],
      });
      await runtime.prisma.user.update({
        where: { id: actor.userId },
        data: { isBanned: true, bannedAt: now, banReason: 'Policy test' },
      });
      release.resolve();
      const denied = await pending;
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual({ error: 'NotFound', message: 'Video not found' });
      const old = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reserved.uploadSession.id },
      });
      expect(old.expiresAt).toEqual(reserved.uploadSession.expiresAt);
      expect(old.verifiedUploadedBytes).toBe(0n);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  test('concurrent admitted creations cannot spend the last rolling budget unit twice', async () => {
    const actor = await owner();
    const policy = makeService();
    const initial = await video(actor.userId);
    const reserved = await policy.service.initMultipartUpload({
      userId: actor.userId,
      videoId: initial.id,
      sizeBytes: 1,
    });
    await policy.service.abortMultipartUpload({
      userId: actor.userId,
      videoId: initial.id,
      uploadSessionId: reserved.uploadSession.id,
    });
    const names: [string, string] = [
      createPostgresApplicationName(),
      createPostgresApplicationName(),
    ];
    const clients = names.map((applicationName) =>
      createPrismaClient(runtime.databaseUrl, { applicationName }),
    );
    const videos = [await video(actor.userId), await video(actor.userId)];
    const gate = holdRow('users', actor.userId);
    const operations: Promise<unknown>[] = [];
    try {
      await waitForBarrier({
        description: 'actual user lock before competing FK inserts',
        signal: gate.acquired,
        operations: [gate.operation],
      });
      for (const [index, client] of clients.entries()) {
        const created = videos[index];
        if (!created) throw new Error('Missing video');
        const pending = makeService(
          {},
          runtime.videoObjectStorage,
          client,
        ).service.initMultipartUpload({ userId: actor.userId, videoId: created.id, sizeBytes: 1 });
        void pending.catch(() => undefined);
        operations.push(pending);
      }
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: names,
        expectedCount: 2,
        queryFragments: ['INSERT', 'video_upload_sessions'],
      });
      gate.release();
      await gate.operation;
      const outcomes = await Promise.allSettled(operations);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected')
        expect(rejected.reason).toBeInstanceOf(VideoTranscodeAdmissionFullError);
      expect(
        await runtime.prisma.externalResourceTarget.count({
          where: { userId: actor.userId, role: 'source' },
        }),
      ).toBe(2);
    } finally {
      gate.release();
      await Promise.allSettled([gate.operation, ...operations]);
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });
});
