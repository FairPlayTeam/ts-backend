import type { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ObjectStorageUnavailableError, type ObjectStorage } from '../../src/lib/objectStorage.js';
import {
  EXTERNAL_RESOURCE_QUIESCENCE_MS,
  createExternalResourceReconciler,
} from '../../src/services/externalResources.js';
import {
  createVideoUploadsReconciliationHandlers,
  createVideoUploadsService,
} from '../../src/modules/videoUploads/index.js';
import {
  InvalidVideoUploadSessionStateError,
  VideoStorageQuotaExceededError,
  VideoTranscodeAdmissionFullError,
  VideoUploadSizeMismatchError,
  VIDEO_UPLOAD_SESSION_STATE_MESSAGE,
} from '../../src/modules/videoUploads/errors.js';
import { createPng, createVerifiedSession } from './support/fixtures.js';
import {
  coordinateLockInterleavingSettled,
  coordinateWhilePaused,
  waitForBarrier,
} from './support/asyncBarriers.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  createIntegrationApp,
  createIntegrationVideoUploadsDependencies,
  createIntegrationVideoUploadsService,
  createPostgresApplicationName,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

// Hold a real transaction after all its SQL effects, before the commit.
const holdUploadTransition = (prisma: PrismaClient, status: 'aborting' | 'completed') => {
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const observedPrisma = new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) =>
          target.$transaction(
            async (tx) => {
              let transitioned = false;
              const observedTx = new Proxy(tx, {
                get(transaction, key) {
                  if (key === 'videoUploadSession') {
                    return new Proxy(transaction.videoUploadSession, {
                      get(sessions, method) {
                        if (method === 'updateMany') {
                          return async (args: Prisma.VideoUploadSessionUpdateManyArgs) => {
                            const result = await sessions.updateMany(args);
                            if (args.data.status === status && result.count > 0)
                              transitioned = true;
                            return result;
                          };
                        }
                        if (method === 'update') {
                          return async (args: Prisma.VideoUploadSessionUpdateArgs) => {
                            const result = await sessions.update(args);
                            if (args.data.status === status) transitioned = true;
                            return result;
                          };
                        }
                        const value: unknown = Reflect.get(sessions, method, sessions);
                        return typeof value === 'function' ? value.bind(sessions) : value;
                      },
                    });
                  }
                  const value: unknown = Reflect.get(transaction, key, transaction);
                  return typeof value === 'function' ? value.bind(transaction) : value;
                },
              });
              const result = await run(observedTx);
              if (transitioned && !held) {
                held = true;
                paused.resolve();
                await release.promise;
              }
              return result;
            },
            { ...options, timeout: 15_000 },
          );
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { prisma: observedPrisma, paused: paused.promise, release: release.resolve };
};

describe('terminal multipart completion', () => {
  let runtime: TestRuntime;
  beforeAll(async () => {
    runtime = await startRuntime();
  });
  beforeEach(async () => {
    await resetState(runtime);
  });
  afterAll(async () => {
    await stopRuntime(runtime);
  });

  const reserve = async (
    label: string,
    sizeBytes = 1,
    existingOwner?: Awaited<ReturnType<typeof createVerifiedSession>>,
  ) => {
    const owner =
      existingOwner ??
      (await createVerifiedSession(runtime, {
        email: `${label}@example.com`,
        username: label.replaceAll('-', '_'),
      }));
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: label,
      tags: [],
      license: 'cc0',
      allowComments: true,
    });
    const { uploadSession } = await runtime.videoUploadsService.initMultipartUpload({
      userId: owner.userId,
      videoId: video.video.id,
      sizeBytes,
    });
    const { externalResourceTargetId: targetId } =
      await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: uploadSession.id },
        select: { externalResourceTargetId: true },
      });
    const input = {
      userId: owner.userId,
      videoId: video.video.id,
      uploadSessionId: uploadSession.id,
      parts: [{ partNumber: 1, etag: 'fabricated-etag' }],
    };
    return { owner, video: video.video, uploadSession, targetId, input };
  };
  type Reservation = Awaited<ReturnType<typeof reserve>>;
  const putPart = async (reservation: Reservation, body = Buffer.from('x')) => {
    const signed = await runtime.videoUploadsService.signMultipartUploadParts({
      ...reservation.input,
      partNumbers: [1],
    });
    const response = await fetch(signed.parts[0]?.url ?? '', { method: 'PUT', body });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('Garage did not return the uploaded part ETag');
    return [{ partNumber: 1, etag }];
  };
  const createObservedService = (
    storage: ObjectStorage,
    prisma = runtime.prisma,
    now = () => new Date(),
  ) => {
    const reconciler = createExternalResourceReconciler({
      prisma,
      objectStorage: storage,
      clock: { now },
      logger: testLogger,
    });
    const deps = createIntegrationVideoUploadsDependencies(prisma, storage, reconciler, { now });
    return {
      reconciler,
      handlers: createVideoUploadsReconciliationHandlers(deps),
      service: createVideoUploadsService(deps),
    };
  };
  const assertUnpublished = async (
    reservation: Reservation,
    processingStatus: 'draft' | 'uploading' = 'draft',
  ) => {
    expect(
      await runtime.prisma.video.findUniqueOrThrow({
        where: { id: reservation.video.id },
        select: { sourceUploadSessionId: true, sourceObjectKey: true, processingStatus: true },
      }),
    ).toEqual({ sourceUploadSessionId: null, sourceObjectKey: null, processingStatus });
    expect(
      await runtime.prisma.videoTranscodeJob.count({ where: { videoId: reservation.video.id } }),
    ).toBe(0);
  };
  const clean = async (reservation: Reservation) => {
    const target = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: { id: reservation.targetId },
    });
    const now = () =>
      new Date(
        Math.max(target.nextAttemptAt.getTime(), target.quiescenceNotBefore?.getTime() ?? 0) + 1,
      );
    const observed = createObservedService(runtime.videoObjectStorage, runtime.prisma, now);
    expect(
      await observed.reconciler.reconcileTarget({
        targetId: reservation.targetId,
        roles: ['source'],
        handlers: observed.handlers,
      }),
    ).toBe('confirmed');
    expect(
      await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reservation.uploadSession.id },
      }),
    ).toMatchObject({ status: 'aborted' });
    expect(
      await runtime.videoObjectStorage.headObject({
        bucket: reservation.uploadSession.bucket,
        objectKey: reservation.uploadSession.objectKey,
      }),
    ).toBeNull();
    expect(
      await runtime.prisma.externalMultipartHandle.count({
        where: { targetId: reservation.targetId },
      }),
    ).toBe(0);
  };

  const persistCompleting = async (reservation: Reservation, etag: string) => {
    await runtime.prisma.$transaction([
      runtime.prisma.videoUploadSession.update({
        where: { id: reservation.uploadSession.id },
        data: { status: 'completing', expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      }),
      runtime.prisma.videoUploadPart.create({
        data: { uploadSessionId: reservation.uploadSession.id, partNumber: 1, etag },
      }),
      runtime.prisma.externalResourceTarget.update({
        where: { id: reservation.targetId },
        data: { nextAttemptAt: new Date(Date.now() - 1) },
      }),
    ]);
  };

  for (const [index, etag] of [
    '\u0001',
    '\u001f',
    '\uffff',
    '\ufffe',
    '\u0000',
    'opaque\u000b',
    '\u000cop aque',
    '\ud800',
    '\udc00',
  ].entries()) {
    test(`rejects XML-incompatible ETag ${index} at HTTP and business boundaries before persistence`, async () => {
      const reservation = await reserve(`xml-hostile-${index}`);
      let completions = 0;
      let heads = 0;
      const observed = createObservedService({
        ...runtime.videoObjectStorage,
        completeMultipartUpload: async (input) => {
          completions++;
          return runtime.videoObjectStorage.completeMultipartUpload(input);
        },
        headObject: async (input) => {
          heads++;
          return runtime.videoObjectStorage.headObject(input);
        },
      });
      const app = await createIntegrationApp(runtime, { videoUploadsService: observed.service });
      const response = await request(app)
        .post(
          `/videos/${reservation.video.publicId}/upload/multipart/${reservation.uploadSession.id}/complete`,
        )
        .set('Authorization', `Bearer ${reservation.owner.sessionKey}`)
        .send({ parts: [{ partNumber: 1, etag }] });
      expect(response.status).toBe(400);
      await expect(
        observed.service.completeMultipartUpload({
          ...reservation.input,
          parts: [{ partNumber: 1, etag }],
        }),
      ).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);
      expect(completions).toBe(0);
      expect(heads).toBe(0);
      expect(
        await runtime.prisma.videoUploadSession.findUniqueOrThrow({
          where: { id: reservation.uploadSession.id },
          include: { externalResourceTarget: true, parts: true },
        }),
      ).toMatchObject({
        status: 'initiated',
        parts: [],
        externalResourceTarget: { goal: 'present', state: 'writing', reconciliationLeaseId: null },
      });
      expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
    });
  }

  for (const [index, etag] of ['\u0001', '\u001f', '\uffff'].entries()) {
    test(`Garage MalformedXML ${index} remains recoverable for a persisted completing session`, async () => {
      const reservation = await reserve(`xml-legacy-${index}`);
      await expect(
        runtime.videoObjectStorage.completeMultipartUpload({
          objectKey: reservation.uploadSession.objectKey,
          uploadId: reservation.uploadSession.uploadId ?? '',
          parts: [{ partNumber: 1, etag }],
        }),
      ).rejects.toMatchObject({
        name: 'MultipartCompletionRejectedError',
        code: 'MalformedXML',
        cause: { name: 'MalformedXML' },
      });
      await persistCompleting(reservation, etag);
      expect(await runtime.reconcileVideoExternalResources({ limit: 1 })).toMatchObject({
        claimed: 1,
        confirmed: 0,
        redirectedAbsent: 1,
        failed: 0,
      });
      await assertUnpublished(reservation);
      await clean(reservation);
    });
  }

  test('maintenance recovers all ten historical XML-invalid completions and admits a sixth account', async () => {
    const reservations: Reservation[] = [];
    for (let account = 0; account < 5; account++) {
      const first = await reserve(`xml-saturation-${account}`);
      reservations.push(first);
      await persistCompleting(first, ['\u0001', '\u001f', '\uffff'][account % 3] ?? '\u0001');
      const second = await reserve(`xml-saturation-second-${account}`, 1, first.owner);
      reservations.push(second);
      await persistCompleting(second, '\uffff');
    }
    const perUser = await runtime.prisma.videoUploadSession.groupBy({
      by: ['userId'],
      _count: { _all: true },
    });
    expect(perUser.map((group) => group._count._all)).toEqual([2, 2, 2, 2, 2]);
    expect(await runtime.prisma.videoUploadSession.count({ where: { status: 'completing' } })).toBe(
      10,
    );
    expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
    expect(
      await runtime.videoUploadsService.expireMultipartUploadSessions({
        expiredBefore: new Date(Date.now() + 48 * 60 * 60 * 1000),
      }),
    ).toEqual({ uploadSessionsExpired: 0 });
    const owner = await createVerifiedSession(runtime, {
      email: 'xml-legitimate@example.com',
      username: 'xml_legitimate',
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Legitimate',
      tags: [],
      license: 'cc0',
      allowComments: true,
    });
    const app = await createIntegrationApp(runtime);
    const init = () =>
      request(app)
        .post(`/videos/${video.video.publicId}/upload/multipart/init`)
        .set('Authorization', `Bearer ${owner.sessionKey}`)
        .send({ sizeBytes: 1 });
    expect((await init()).status).toBe(429);
    expect(await runtime.reconcileVideoExternalResources({ limit: 10 })).toMatchObject({
      claimed: 10,
      confirmed: 0,
      redirectedAbsent: 10,
      failed: 0,
    });
    expect((await init()).status).toBe(201);
    expect(await runtime.prisma.videoUploadSession.count({ where: { status: 'completing' } })).toBe(
      0,
    );
    for (const reservation of reservations) {
      await assertUnpublished(reservation);
      await clean(reservation);
    }
  });

  test('keeps Unicode and escaped XML punctuation in opaque ETags through HTTP and S3', async () => {
    const reservation = await reserve('xml-opaque');
    await putPart(reservation);
    const etag = 'opaque&<>"\' ]]>' + 'été 🤖';
    await expect(
      runtime.videoObjectStorage.completeMultipartUpload({
        objectKey: reservation.uploadSession.objectKey,
        uploadId: reservation.uploadSession.uploadId ?? '',
        parts: [{ partNumber: 1, etag }],
      }),
    ).rejects.toMatchObject({ name: 'MultipartCompletionRejectedError', code: 'InvalidPart' });
    const app = await createIntegrationApp(runtime);
    const response = await request(app)
      .post(
        `/videos/${reservation.video.publicId}/upload/multipart/${reservation.uploadSession.id}/complete`,
      )
      .set('Authorization', `Bearer ${reservation.owner.sessionKey}`)
      .send({ parts: [{ partNumber: 1, etag }] });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Conflict',
      message: VIDEO_UPLOAD_SESSION_STATE_MESSAGE,
    });
    expect(
      await runtime.prisma.videoUploadPart.findMany({
        where: { uploadSessionId: reservation.uploadSession.id },
        select: { etag: true },
      }),
    ).toEqual([{ etag }]);
    await assertUnpublished(reservation);
    await clean(reservation);
  });

  test('a legacy MalformedXML rejection with unavailable HEAD remains retryable', async () => {
    const reservation = await reserve('xml-head-failure');
    await persistCompleting(reservation, '\u0001');
    const observed = createObservedService({
      ...runtime.videoObjectStorage,
      headObject: async () => {
        throw new ObjectStorageUnavailableError('HEAD unavailable');
      },
    });
    await expect(
      observed.reconciler.reconcileTarget({
        targetId: reservation.targetId,
        roles: ['source'],
        handlers: observed.handlers,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    expect(
      await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reservation.uploadSession.id },
        include: { externalResourceTarget: true },
      }),
    ).toMatchObject({
      status: 'completing',
      externalResourceTarget: { goal: 'present', state: 'writing', attempts: 1 },
    });
    expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
  });

  test('an XML-invalid legacy completion still recovers a conforming real object from HEAD', async () => {
    const reservation = await reserve('xml-head-present');
    const parts = await putPart(reservation);
    await runtime.videoObjectStorage.completeMultipartUpload({
      objectKey: reservation.uploadSession.objectKey,
      uploadId: reservation.uploadSession.uploadId ?? '',
      parts,
    });
    await expect(
      runtime.videoObjectStorage.completeMultipartUpload({
        objectKey: reservation.uploadSession.objectKey,
        uploadId: reservation.uploadSession.uploadId ?? '',
        parts: [{ partNumber: 1, etag: '\u0001' }],
      }),
    ).rejects.toMatchObject({ code: 'MalformedXML' });
    await persistCompleting(reservation, '\u0001');
    expect(await runtime.reconcileVideoExternalResources({ limit: 1 })).toMatchObject({
      claimed: 1,
      confirmed: 1,
      redirectedAbsent: 0,
      failed: 0,
    });
    expect(
      await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reservation.uploadSession.id },
      }),
    ).toMatchObject({ status: 'completed' });
    expect(await runtime.prisma.videoTranscodeJob.count()).toBe(1);
  });

  test('observes typed Garage rejections for missing parts, a wrong ETag and a missing upload', async () => {
    const reservation = await reserve('storage-rejection');
    const rawInput = {
      bucket: reservation.uploadSession.bucket,
      objectKey: reservation.uploadSession.objectKey,
      uploadId: reservation.uploadSession.uploadId ?? '',
      parts: reservation.input.parts,
    };
    await expect(
      runtime.videoObjectStorage.completeMultipartUpload(rawInput),
    ).rejects.toMatchObject({
      name: 'MultipartCompletionRejectedError',
      code: 'InvalidRequest',
      cause: { name: 'InvalidRequest', message: 'Bad request: No data was uploaded' },
    });
    await putPart(reservation);
    await expect(
      runtime.videoObjectStorage.completeMultipartUpload(rawInput),
    ).rejects.toMatchObject({ name: 'MultipartCompletionRejectedError', code: 'InvalidPart' });
    await runtime.videoObjectStorage.abortMultipartUpload(rawInput);
    await expect(
      runtime.videoObjectStorage.completeMultipartUpload(rawInput),
    ).rejects.toMatchObject({ name: 'MultipartCompletionRejectedError', code: 'NoSuchUpload' });
  });

  for (const xmlInvalid of [false, true]) {
    test(`${xmlInvalid ? 'ten HTTP XML-invalid completions' : 'ten fictitious completions'} cannot retain the ten slots or block a sixth account`, async () => {
      const app = await createIntegrationApp(runtime);
      const targets: string[] = [];
      for (let account = 0; account < 5; account++) {
        const owner = await createVerifiedSession(runtime, {
          email: `fictitious-${account}@example.com`,
          username: `fictitious_${account}`,
        });
        for (let index = 0; index < 2; index++) {
          const video = await runtime.videosService.createVideo({
            userId: owner.userId,
            title: 'Fictitious',
            tags: [],
            license: 'cc0',
            allowComments: true,
          });
          const initialized = await request(app)
            .post(`/videos/${video.video.publicId}/upload/multipart/init`)
            .set('Authorization', `Bearer ${owner.sessionKey}`)
            .send({ sizeBytes: 1 });
          expect(initialized.status).toBe(201);
          const sessionId: unknown = initialized.body.uploadSession.id;
          if (typeof sessionId !== 'string') throw new Error('Missing public upload reference');
          const completionPath = `/videos/${video.video.publicId}/upload/multipart/${sessionId}/complete`;
          const complete = () =>
            request(app)
              .post(completionPath)
              .set('Authorization', `Bearer ${owner.sessionKey}`)
              .send({
                parts: [
                  {
                    partNumber: 1,
                    etag: xmlInvalid
                      ? ['\u0001', '\u001f', '\uffff'][(account + index) % 3]
                      : 'fabricated-etag',
                  },
                ],
              });
          for (let retry = 0; retry < 2; retry++) {
            const response = await complete();
            expect(response.status).toBe(xmlInvalid ? 400 : 409);
            if (!xmlInvalid)
              expect(response.body).toEqual({
                error: 'Conflict',
                message: VIDEO_UPLOAD_SESSION_STATE_MESSAGE,
              });
          }
          const state = await request(app)
            .get(`/videos/${video.video.publicId}/upload/multipart/${sessionId}`)
            .set('Authorization', `Bearer ${owner.sessionKey}`);
          expect(state.status).toBe(200);
          expect(Object.keys(state.body.uploadSession).sort()).toEqual(
            [
              'id',
              'publicId',
              'status',
              'partSizeBytes',
              'expectedSizeBytes',
              'partCount',
              'expiresAt',
              'completedAt',
              'abortedAt',
              'expiredAt',
              'createdAt',
              'updatedAt',
              'parts',
            ].sort(),
          );
          expect(state.body.uploadSession.status).toBe(xmlInvalid ? 'initiated' : 'aborting');
          if (xmlInvalid) expect(state.body.uploadSession.parts).toEqual([]);
          const session = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
            where: { id: sessionId },
            include: { externalResourceTarget: true },
          });
          expect(session.externalResourceTarget).toMatchObject({
            goal: xmlInvalid ? 'present' : 'absent',
            state: xmlInvalid ? 'writing' : 'quiescing',
            reconciliationLeaseId: null,
          });
          targets.push(session.externalResourceTargetId);
        }
      }
      expect(
        await runtime.prisma.videoUploadSession.count({ where: { status: 'completing' } }),
      ).toBe(0);
      expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
      expect(
        await runtime.videoUploadsService.expireMultipartUploadSessions({
          expiredBefore: new Date(Date.now() + 48 * 60 * 60 * 1000),
        }),
      ).toEqual({ uploadSessionsExpired: xmlInvalid ? 10 : 0 });
      const legitimate = await createVerifiedSession(runtime, {
        email: 'legitimate@example.com',
        username: 'legitimate',
      });
      const legitimateVideo = await runtime.videosService.createVideo({
        userId: legitimate.userId,
        title: 'Legitimate',
        tags: [],
        license: 'cc0',
        allowComments: true,
      });
      const admitted = await request(app)
        .post(`/videos/${legitimateVideo.video.publicId}/upload/multipart/init`)
        .set('Authorization', `Bearer ${legitimate.sessionKey}`)
        .send({ sizeBytes: 1 });
      expect(admitted.status).toBe(201);
      const later = createObservedService(
        runtime.videoObjectStorage,
        runtime.prisma,
        () => new Date(Date.now() + (xmlInvalid ? 50 : 2) * EXTERNAL_RESOURCE_QUIESCENCE_MS),
      );
      for (const targetId of targets)
        expect(
          await later.reconciler.reconcileTarget({
            targetId,
            roles: ['source'],
            handlers: later.handlers,
          }),
        ).toBe('confirmed');
      expect(
        await runtime.prisma.videoUploadSession.count({
          where: { status: xmlInvalid ? 'expired' : 'aborted' },
        }),
      ).toBe(10);
      expect(
        await runtime.prisma.externalResourceTarget.count({
          where: { id: { in: targets }, state: 'confirmed_absent' },
        }),
      ).toBe(10);
    });
  }

  test('maintenance abandons an existing expired completing session without client cooperation', async () => {
    const reservation = await reserve('historical-invalid');
    await persistCompleting(reservation, 'fabricated-etag');
    expect(await runtime.reconcileVideoExternalResources({ limit: 1 })).toMatchObject({
      claimed: 1,
      redirectedAbsent: 1,
      failed: 0,
    });
    await assertUnpublished(reservation);
    await clean(reservation);
  });

  for (const sizeMismatch of [false, true]) {
    test(`${sizeMismatch ? 'a size mismatch' : 'a wrong uploaded ETag'} abandons both the source and its confirmed thumbnail`, async () => {
      const reservation = await reserve(
        sizeMismatch ? 'size-mismatch' : 'wrong-etag',
        sizeMismatch ? 2 : 1,
      );
      const parts = await putPart(reservation);
      const png = await createPng();
      await runtime.videoUploadsService.uploadSourceThumbnail({
        ...reservation.input,
        file: { buffer: png, size: png.length },
      });
      await expect(
        runtime.videoUploadsService.completeMultipartUpload({
          ...reservation.input,
          parts: sizeMismatch ? parts : reservation.input.parts,
        }),
      ).rejects.toBeInstanceOf(
        sizeMismatch ? VideoUploadSizeMismatchError : InvalidVideoUploadSessionStateError,
      );
      const targets = await runtime.prisma.externalResourceTarget.findMany({
        where: { generation: reservation.uploadSession.id },
      });
      expect(targets).toHaveLength(2);
      expect(
        targets.every((target) => target.goal === 'absent' && target.state === 'quiescing'),
      ).toBe(true);
      await assertUnpublished(reservation);
      await clean(reservation);
      const thumbnail = targets.find((target) => target.role === 'source_thumbnail');
      if (!thumbnail) throw new Error('Missing thumbnail cleanup target');
      const later = createObservedService(
        runtime.videoObjectStorage,
        runtime.prisma,
        () => new Date(thumbnail.nextAttemptAt.getTime() + 1),
      );
      expect(
        await later.reconciler.reconcileTarget({
          targetId: thumbnail.id,
          roles: ['source_thumbnail'],
          handlers: later.handlers,
        }),
      ).toBe('confirmed');
      expect(await runtime.prisma.videoSourceThumbnail.count()).toBe(0);
      expect(
        await runtime.videoObjectStorage.headObject({
          bucket: thumbnail.bucket,
          objectKey: thumbnail.selector,
        }),
      ).toBeNull();
    });
  }

  test('released admission capacity does not release storage quota before confirmed cleanup', async () => {
    const reservation = await reserve('retained-quota');
    await expect(
      runtime.videoUploadsService.completeMultipartUpload(reservation.input),
    ).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);
    const limited = createIntegrationVideoUploadsService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
      { userStorageQuotaBytes: 1 },
    );
    await expect(
      limited.initMultipartUpload({ ...reservation.input, sizeBytes: 1 }),
    ).rejects.toBeInstanceOf(VideoStorageQuotaExceededError);
    await clean(reservation);
    await expect(
      limited.initMultipartUpload({ ...reservation.input, sizeBytes: 1 }),
    ).resolves.toMatchObject({ uploadSession: { status: 'initiated' } });
  });

  test('keeps a transient failure retryable even after +48 hours', async () => {
    const reservation = await reserve('transient');
    const observed = createObservedService({
      ...runtime.videoObjectStorage,
      completeMultipartUpload: async () => {
        throw new ObjectStorageUnavailableError('network unavailable');
      },
    });
    await expect(
      observed.service.completeMultipartUpload(reservation.input),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    expect(
      await observed.service.expireMultipartUploadSessions({
        expiredBefore: new Date(Date.now() + 48 * 60 * 60 * 1000),
      }),
    ).toEqual({ uploadSessionsExpired: 0 });
    expect(
      await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reservation.uploadSession.id },
        include: { externalResourceTarget: true },
      }),
    ).toMatchObject({
      status: 'completing',
      externalResourceTarget: { goal: 'present', state: 'writing', attempts: 1 },
    });
  });

  test('a definitive completion rejection with an unavailable HEAD remains ambiguous', async () => {
    const reservation = await reserve('head-unavailable');
    const observed = createObservedService({
      ...runtime.videoObjectStorage,
      headObject: async () => {
        throw new ObjectStorageUnavailableError('HEAD unavailable');
      },
    });
    await expect(
      observed.service.completeMultipartUpload(reservation.input),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    expect(
      await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reservation.uploadSession.id },
      }),
    ).toMatchObject({ status: 'completing' });
  });

  test('recovers a successful completion whose response was lost and queues exactly one job', async () => {
    const reservation = await reserve('lost-response');
    const parts = await putPart(reservation);
    const observed = createObservedService({
      ...runtime.videoObjectStorage,
      completeMultipartUpload: async (input) => {
        await runtime.videoObjectStorage.completeMultipartUpload(input);
        throw new ObjectStorageUnavailableError('Response lost');
      },
    });
    await expect(
      observed.service.completeMultipartUpload({ ...reservation.input, parts }),
    ).resolves.toMatchObject({ uploadSession: { status: 'completed' } });
    await expect(
      observed.service.completeMultipartUpload({ ...reservation.input, parts }),
    ).resolves.toMatchObject({ uploadSession: { status: 'completed' } });
    expect(
      await runtime.prisma.videoTranscodeJob.count({ where: { videoId: reservation.video.id } }),
    ).toBe(1);
  });

  test('an already completed source is recovered from NoSuchUpload rather than abandoned', async () => {
    const reservation = await reserve('completed-before-api');
    const parts = await putPart(reservation);
    await runtime.videoObjectStorage.completeMultipartUpload({
      bucket: reservation.uploadSession.bucket,
      objectKey: reservation.uploadSession.objectKey,
      uploadId: reservation.uploadSession.uploadId ?? '',
      parts,
    });
    await expect(
      runtime.videoUploadsService.completeMultipartUpload({ ...reservation.input, parts }),
    ).resolves.toMatchObject({ uploadSession: { status: 'completed' } });
    expect(await runtime.prisma.videoTranscodeJob.count()).toBe(1);
  });

  test('a completing source can still publish after its expiry when real storage confirms it', async () => {
    const reservation = await reserve('valid-after-expiry');
    const parts = await putPart(reservation);
    await runtime.prisma.$transaction([
      runtime.prisma.videoUploadSession.update({
        where: { id: reservation.uploadSession.id },
        data: { status: 'completing', expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      }),
      runtime.prisma.videoUploadPart.createMany({
        data: parts.map((part) => ({ uploadSessionId: reservation.uploadSession.id, ...part })),
      }),
      runtime.prisma.externalResourceTarget.update({
        where: { id: reservation.targetId },
        data: { nextAttemptAt: new Date(Date.now() - 1) },
      }),
    ]);
    expect(await runtime.reconcileVideoExternalResources({ limit: 1 })).toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    expect(await runtime.prisma.videoTranscodeJob.count()).toBe(1);
  });

  test('a revoked lease cannot publish a late real completion after abandonment frees the slot', async () => {
    const reservation = await reserve('late-completion');
    const parts = await putPart(reservation);
    const completeFinished = Promise.withResolvers<void>();
    const releaseCompletion = Promise.withResolvers<void>();
    const waiterName = createPostgresApplicationName();
    const waiter = createPrismaClient(runtime.databaseUrl, { applicationName: waiterName });
    const observed = createObservedService(
      {
        ...runtime.videoObjectStorage,
        completeMultipartUpload: async (input) => {
          await runtime.videoObjectStorage.completeMultipartUpload(input);
          completeFinished.resolve();
          await releaseCompletion.promise;
        },
      },
      waiter,
    );
    const oldCompletion = observed.service.completeMultipartUpload({ ...reservation.input, parts });
    const held = holdUploadTransition(runtime.prisma, 'aborting');
    const aborter = createIntegrationVideoUploadsService(
      held.prisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    try {
      await waitForBarrier({
        operations: [oldCompletion],
        signal: completeFinished.promise,
        description: 'real S3 completion before its delayed return',
      });
      const outcomes = await coordinateLockInterleavingSettled({
        firstOperation: aborter.abortMultipartUpload(reservation.input),
        firstPaused: held.paused,
        firstBarrierDescription: 'durable absence changes before commit',
        releaseFirst: held.release,
        secondLockDescription: 'obsolete reconciliation lease renewal waits on the target',
        startSecond: () => {
          releaseCompletion.resolve();
          return oldCompletion;
        },
        waitForSecondLock: (signal) =>
          waitForPostgresLockWaiters(runtime.prisma, {
            applicationNames: [waiterName],
            expectedCount: 1,
            queryFragments: ['UPDATE', 'external_resource_targets'],
            signal,
          }),
      });
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe('rejected');
      if (outcomes[1].status === 'rejected')
        expect(outcomes[1].reason).toMatchObject({
          cause: { message: 'External resource reconciliation lease was lost' },
        });
      await assertUnpublished(reservation);
      expect(
        await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
          where: { id: reservation.targetId },
        }),
      ).toMatchObject({ goal: 'absent', state: 'quiescing' });
      await expect(
        runtime.videoUploadsService.initMultipartUpload({ ...reservation.input, sizeBytes: 1 }),
      ).resolves.toMatchObject({ uploadSession: { status: 'initiated' } });
      await clean(reservation);
    } finally {
      releaseCompletion.resolve();
      held.release();
      await Promise.allSettled([oldCompletion]);
      await waiter.$disconnect();
    }
  });

  for (const legacyXml of [false, true]) {
    test(`${legacyXml ? 'MalformedXML terminal takeover' : 'terminal takeover'} fences an obsolete completion even when real bytes appear after slot reuse`, async () => {
      const reservation = await reserve('terminal-takeover');
      // Keep the real signed capability acquired before completion closes the session.
      const signed = await runtime.videoUploadsService.signMultipartUploadParts({
        ...reservation.input,
        partNumbers: [1],
      });
      if (legacyXml) await persistCompleting(reservation, '\u0001');
      const prepared = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const old = createObservedService({
        ...runtime.videoObjectStorage,
        completeMultipartUpload: async () => {
          expect(
            await runtime.videoObjectStorage.headObject({
              objectKey: reservation.uploadSession.objectKey,
            }),
          ).toBeNull();
          prepared.resolve();
          await release.promise;
        },
      });
      const outcome = await coordinateWhilePaused({
        firstOperation: (legacyXml
          ? old.reconciler.reconcileTarget({
              targetId: reservation.targetId,
              roles: ['source'],
              handlers: old.handlers,
            })
          : old.service.completeMultipartUpload(reservation.input)
        ).then(
          (result) => ({ result, error: null }),
          (error: unknown) => ({ result: null, error }),
        ),
        firstPaused: prepared.promise,
        firstBarrierDescription: 'obsolete real PostgreSQL claim and absent S3 object',
        releaseFirst: release.resolve,
        whilePausedDescription:
          'new lease abandons the source, reuses capacity, and observes a late S3 object',
        runWhilePaused: async () => {
          const now = () => new Date(Date.now() + 6 * 60 * 1000);
          const replacement = createObservedService(
            runtime.videoObjectStorage,
            runtime.prisma,
            now,
          );
          expect(
            await replacement.reconciler.reconcileTarget({
              targetId: reservation.targetId,
              roles: ['source'],
              handlers: replacement.handlers,
            }),
          ).toBe('redirected_absent');
          await assertUnpublished(reservation);
          const limited = createIntegrationVideoUploadsService(
            runtime.prisma,
            runtime.videoObjectStorage,
            runtime.videoExternalResources,
            { maxTranscodeOutstandingJobs: 1 },
          );
          expect(
            (await limited.initMultipartUpload({ ...reservation.input, sizeBytes: 1 }))
              .uploadSession.status,
          ).toBe('initiated');
          const response = await fetch(signed.parts[0]?.url ?? '', {
            method: 'PUT',
            body: Buffer.from('x'),
          });
          expect(response.status).toBe(200);
          const etag = response.headers.get('etag');
          if (!etag) throw new Error('Garage did not return a late part ETag');
          await runtime.videoObjectStorage.completeMultipartUpload({
            objectKey: reservation.uploadSession.objectKey,
            uploadId: reservation.uploadSession.uploadId ?? '',
            parts: [{ partNumber: 1, etag }],
          });
          expect(
            await runtime.videoObjectStorage.headObject({
              objectKey: reservation.uploadSession.objectKey,
            }),
          ).toMatchObject({ sizeBytes: 1 });
        },
      });
      await assertUnpublished(reservation, 'uploading');
      expect(outcome[0].error).toMatchObject(
        legacyXml
          ? { message: 'External resource reconciliation lease was lost' }
          : {
              cause: { message: 'External resource reconciliation lease was lost' },
            },
      );
      expect(
        await runtime.prisma.videoUploadSession.findUniqueOrThrow({
          where: { id: reservation.uploadSession.id },
        }),
      ).toMatchObject({ status: 'aborting' });
      await clean(reservation);
    });
  }

  test('publication winning the transaction race retains its reservation as a queued job', async () => {
    const reservation = await reserve('publication-first');
    const parts = await putPart(reservation);
    const held = holdUploadTransition(runtime.prisma, 'completed');
    const publisher = createObservedService(runtime.videoObjectStorage, held.prisma);
    const waiterName = createPostgresApplicationName();
    const waiter = createPrismaClient(runtime.databaseUrl, { applicationName: waiterName });
    const aborter = createIntegrationVideoUploadsService(
      waiter,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    try {
      const outcomes = await coordinateLockInterleavingSettled({
        firstOperation: publisher.service.completeMultipartUpload({ ...reservation.input, parts }),
        firstPaused: held.paused,
        firstBarrierDescription: 'published source and job before commit',
        releaseFirst: held.release,
        startSecond: () => aborter.abortMultipartUpload(reservation.input),
        secondLockDescription: 'abort waits on the publication session update',
        waitForSecondLock: (signal) =>
          waitForPostgresLockWaiters(runtime.prisma, {
            applicationNames: [waiterName],
            expectedCount: 1,
            queryFragments: ['UPDATE', 'video_upload_sessions'],
            signal,
          }),
      });
      if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
      expect(outcomes[1].status).toBe('rejected');
      if (outcomes[1].status === 'rejected')
        expect(outcomes[1].reason).toBeInstanceOf(InvalidVideoUploadSessionStateError);
      expect(await runtime.prisma.videoTranscodeJob.count()).toBe(1);
      expect(
        await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
          where: { id: reservation.targetId },
        }),
      ).toMatchObject({ goal: 'present', state: 'confirmed_present' });
      const nextVideo = await runtime.videosService.createVideo({
        userId: reservation.owner.userId,
        title: 'Capacity still reserved',
        tags: [],
        license: 'cc0',
        allowComments: true,
      });
      const limited = createIntegrationVideoUploadsService(
        runtime.prisma,
        runtime.videoObjectStorage,
        runtime.videoExternalResources,
        { maxTranscodeOutstandingJobs: 1 },
      );
      await expect(
        limited.initMultipartUpload({
          userId: reservation.owner.userId,
          videoId: nextVideo.video.id,
          sizeBytes: 1,
        }),
      ).rejects.toBeInstanceOf(VideoTranscodeAdmissionFullError);
    } finally {
      held.release();
      await waiter.$disconnect();
    }
  });

  for (const publication of [true, false]) {
    test(`rejects ${publication ? 'publication' : 'abandonment'} when the lease expires during domain work`, async () => {
      const reservation = await reserve('expired-domain-work');
      const parts = publication ? await putPart(reservation) : reservation.input.parts;
      const etag = parts[0]?.etag;
      if (!etag) throw new Error('Missing completion ETag');
      await persistCompleting(reservation, etag);
      let observedAt = new Date();
      const observed = createObservedService(
        runtime.videoObjectStorage,
        runtime.prisma,
        () => observedAt,
      );
      const handler = observed.handlers.source;
      const afterDomainWork = async (tx: Prisma.TransactionClient) => {
        // Observe the real SQL effects before the final ownership check must roll them back.
        expect(
          await tx.videoUploadSession.findUniqueOrThrow({
            where: { id: reservation.uploadSession.id },
            select: { status: true },
          }),
        ).toEqual({ status: publication ? 'completed' : 'aborting' });
        expect(await tx.videoTranscodeJob.count({ where: { videoId: reservation.video.id } })).toBe(
          publication ? 1 : 0,
        );
        observedAt = new Date(observedAt.getTime() + 6 * 60 * 1000);
      };
      await expect(
        observed.reconciler.reconcileTarget({
          targetId: reservation.targetId,
          roles: ['source'],
          handlers: {
            ...observed.handlers,
            source: {
              ...handler,
              finalize: async (tx, target, object) => {
                await handler.finalize?.(tx, target, object);
                await afterDomainWork(tx);
              },
              handlePresentRejection: async (tx, target) => {
                await handler.handlePresentRejection?.(tx, target);
                await afterDomainWork(tx);
              },
            },
          },
        }),
      ).rejects.toThrow('External resource reconciliation lease was lost');
      await assertUnpublished(reservation, 'uploading');
      expect(
        await runtime.prisma.videoUploadSession.findUniqueOrThrow({
          where: { id: reservation.uploadSession.id },
        }),
      ).toMatchObject({ status: 'completing' });
      expect(
        await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
          where: { id: reservation.targetId },
        }),
      ).toMatchObject({ goal: 'present', state: 'reconciling' });
    });
  }

  test('a lease expiring after the real HEAD cannot commit source publication', async () => {
    const reservation = await reserve('expired-after-head');
    const parts = await putPart(reservation);
    let observedAt = new Date();
    const observed = createObservedService(
      {
        ...runtime.videoObjectStorage,
        headObject: async (input) => {
          const object = await runtime.videoObjectStorage.headObject(input);
          observedAt = new Date(observedAt.getTime() + 6 * 60 * 1000);
          return object;
        },
      },
      runtime.prisma,
      () => observedAt,
    );
    await expect(
      observed.service.completeMultipartUpload({ ...reservation.input, parts }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    expect(await runtime.prisma.videoTranscodeJob.count()).toBe(0);
    expect(
      await runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: reservation.uploadSession.id },
      }),
    ).toMatchObject({ status: 'completing' });
  });
});
