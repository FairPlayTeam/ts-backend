import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { videoOriginalKey } from '../../src/services/videos/videoObjectKeys.js';
import type { ObjectStorage } from '../../src/lib/objectStorage.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  VideoStorageQuotaExceededError,
  VideoUploadSizeMismatchError,
} from '../../src/services/videos.errors.js';
import { createVerifiedSession, uploadVideoSource } from './support/fixtures.js';
import { VIDEO_OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
import {
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

describe('videos upload integration', () => {
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

  test('reserves uploads before S3, publishes immutable sources, and keeps replaced bytes reserved', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-source-owner@example.com',
      username: 'video_source_owner',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Durable source replacement',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const firstBody = Buffer.from('first immutable source');
    const first = await uploadVideoSource(runtime.videosService, {
      body: firstBody,
      userId: owner.userId,
      videoId: created.video.id,
    });
    const firstTarget = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: {
        id: (
          await runtime.prisma.videoUploadSession.findUniqueOrThrow({
            where: { id: first.uploadSession.id },
            select: { externalResourceTargetId: true },
          })
        ).externalResourceTargetId,
      },
    });

    expect(first.uploadSession.objectKey).toBe(
      `${owner.userId}/${created.video.id}/sources/${first.uploadSession.id}/original.mp4`,
    );
    expect(first.uploadSession.expectedSizeBytes).toBe(firstBody.length);
    expect(firstTarget).toMatchObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      selector: first.uploadSession.objectKey,
      selectorKind: 'exact',
      role: 'source',
      goal: 'present',
      state: 'confirmed_present',
      expectedSizeBytes: BigInt(firstBody.length),
    });
    const firstParts = await runtime.prisma.videoUploadPart.findMany({
      where: { uploadSessionId: first.uploadSession.id },
      select: {
        partNumber: true,
        etag: true,
      },
      orderBy: { partNumber: 'asc' },
    });
    await expect(
      runtime.videosService.completeMultipartUpload({
        userId: owner.userId,
        videoId: created.video.id,
        uploadSessionId: first.uploadSession.id,
        parts: firstParts,
      }),
    ).resolves.toMatchObject({
      uploadSession: {
        id: first.uploadSession.id,
        status: 'completed',
      },
    });
    await expect(
      runtime.prisma.videoTranscodeJob.count({
        where: {
          videoId: created.video.id,
          sourceObjectKey: first.uploadSession.objectKey,
        },
      }),
    ).resolves.toBe(1);

    const secondBody = Buffer.from('second immutable source is different');
    const replacementRequestedAt = Date.now();
    const second = await uploadVideoSource(runtime.videosService, {
      body: secondBody,
      userId: owner.userId,
      videoId: created.video.id,
    });
    const replacementCompletedAt = Date.now();
    const [video, replacedTarget, reserved] = await Promise.all([
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: {
          sourceUploadSessionId: true,
          sourceObjectKey: true,
          sourceSizeBytes: true,
        },
      }),
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: firstTarget.id },
      }),
      runtime.prisma.externalResourceTarget.aggregate({
        where: {
          userId: owner.userId,
          role: 'source',
          state: { not: 'confirmed_absent' },
        },
        _sum: { expectedSizeBytes: true },
      }),
    ]);

    expect(second.uploadSession.objectKey).not.toBe(first.uploadSession.objectKey);
    expect(video).toEqual({
      sourceUploadSessionId: second.uploadSession.id,
      sourceObjectKey: second.uploadSession.objectKey,
      sourceSizeBytes: BigInt(secondBody.length),
    });
    expect(replacedTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    expect(replacedTarget.quiescenceNotBefore?.getTime()).toBeGreaterThanOrEqual(
      replacementRequestedAt + 60 * 60 * 1000,
    );
    expect(replacedTarget.quiescenceNotBefore?.getTime()).toBeLessThanOrEqual(
      replacementCompletedAt + 60 * 60 * 1000,
    );
    expect(reserved._sum.expectedSizeBytes).toBe(BigInt(firstBody.length + secondBody.length));

    const quotaBoundService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
      {
        maxUploadBytes: 1,
        userStorageQuotaBytes: firstBody.length + secondBody.length,
      },
    );

    await expect(
      quotaBoundService.initMultipartUpload({
        userId: owner.userId,
        videoId: created.video.id,
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(VideoStorageQuotaExceededError);

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: { id: firstTarget.id },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });

    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: firstTarget.bucket,
        objectKey: firstTarget.selector,
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: firstTarget.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'confirmed_absent' });

    const afterCleanup = await runtime.prisma.externalResourceTarget.aggregate({
      where: {
        userId: owner.userId,
        role: 'source',
        state: { not: 'confirmed_absent' },
      },
      _sum: { expectedSizeBytes: true },
    });
    expect(afterCleanup._sum.expectedSizeBytes).toBe(BigInt(secondBody.length));
  });

  test('keeps an S3 initialization failure durably scheduled after the PostgreSQL reservation', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-init-failure@example.com',
      username: 'video_init_failure',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Ambiguous initialization',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    let observedReservation = false;
    const failingStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      initiateMultipartUpload: async () => {
        const [sessionCount, targetCount] = await Promise.all([
          runtime?.prisma.videoUploadSession.count({
            where: {
              videoId: created.video.id,
              status: 'initializing',
            },
          }),
          runtime?.prisma.externalResourceTarget.count({
            where: {
              videoId: created.video.id,
              state: 'writing',
            },
          }),
        ]);
        observedReservation = sessionCount === 1 && targetCount === 1;
        throw new Error('simulated ambiguous S3 initialization failure');
      },
    };
    const service = createIntegrationVideosService(
      runtime.prisma,
      failingStorage,
      runtime.videoExternalResources,
    );

    await expect(
      service.initMultipartUpload({
        userId: owner.userId,
        videoId: created.video.id,
        sizeBytes: 128,
      }),
    ).rejects.toThrow('simulated ambiguous S3 initialization failure');
    expect(observedReservation).toBe(true);

    const session = await runtime.prisma.videoUploadSession.findFirstOrThrow({
      where: { videoId: created.video.id },
      include: {
        externalResourceTarget: true,
        multipartHandle: true,
      },
    });

    expect(session.status).toBe('aborting');
    expect(session.multipartHandle).toBeNull();
    expect(session.externalResourceTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
      mayHaveMultipartUpload: true,
    });
    expect(session.externalResourceTarget.quiescenceNotBefore).not.toBeNull();
  });

  test('serializes concurrent upload reservations before S3 and durably rejects a size mismatch', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-concurrent-upload@example.com',
      username: 'video_concurrent',
    });
    const firstVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Concurrent reservation',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const reservations = await Promise.allSettled([
      runtime.videosService.initMultipartUpload({
        userId: owner.userId,
        videoId: firstVideo.video.id,
        sizeBytes: 32,
      }),
      runtime.videosService.initMultipartUpload({
        userId: owner.userId,
        videoId: firstVideo.video.id,
        sizeBytes: 32,
      }),
    ]);
    const acceptedReservation = reservations.find(
      (reservation) => reservation.status === 'fulfilled',
    );
    const rejectedReservation = reservations.find(
      (reservation) => reservation.status === 'rejected',
    );

    expect(acceptedReservation?.status).toBe('fulfilled');
    expect(rejectedReservation?.status).toBe('rejected');

    if (acceptedReservation?.status !== 'fulfilled' || rejectedReservation?.status !== 'rejected') {
      throw new Error('Concurrent reservation result was not split between success and conflict');
    }

    expect(rejectedReservation.reason).toBeInstanceOf(ActiveVideoUploadSessionExistsError);
    expect(
      await runtime.prisma.videoUploadSession.count({
        where: {
          videoId: firstVideo.video.id,
          status: { in: ['initializing', 'initiated', 'uploading', 'completing'] },
        },
      }),
    ).toBe(1);

    await expect(
      runtime.videosService.completeMultipartUpload({
        userId: owner.userId,
        videoId: firstVideo.video.id,
        uploadSessionId: acceptedReservation.value.uploadSession.id,
        parts: [
          { partNumber: 1, etag: '"duplicate-a"' },
          { partNumber: 1, etag: '"duplicate-b"' },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);

    const abortedReservation = await runtime.videosService.abortMultipartUpload({
      userId: owner.userId,
      videoId: firstVideo.video.id,
      uploadSessionId: acceptedReservation.value.uploadSession.id,
    });
    expect(abortedReservation.uploadSession.status).toBe('aborting');
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: (
            await runtime.prisma.videoUploadSession.findUniqueOrThrow({
              where: { id: acceptedReservation.value.uploadSession.id },
              select: { externalResourceTargetId: true },
            })
          ).externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'quiescing',
    });

    const secondVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Declared size mismatch',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const body = Buffer.from('shorter than declared');
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: secondVideo.video.id,
      sizeBytes: body.length + 1,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: secondVideo.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: initialized.uploadSession.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'uploading' });
    const uploadResponse = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body,
    });
    const etag = uploadResponse.headers.get('etag');

    expect(uploadResponse.status).toBe(200);
    expect(etag).not.toBeNull();

    await expect(
      runtime.videosService.completeMultipartUpload({
        userId: owner.userId,
        videoId: secondVideo.video.id,
        uploadSessionId: initialized.uploadSession.id,
        parts: [{ partNumber: 1, etag: etag ?? '' }],
      }),
    ).rejects.toBeInstanceOf(VideoUploadSizeMismatchError);

    const mismatchedSession = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
      where: { id: initialized.uploadSession.id },
      include: { externalResourceTarget: true },
    });
    const mismatchedVideo = await runtime.prisma.video.findUniqueOrThrow({
      where: { id: secondVideo.video.id },
      select: {
        sourceUploadSessionId: true,
        sourceObjectKey: true,
        sourceSizeBytes: true,
      },
    });

    expect(mismatchedSession.status).toBe('aborting');
    expect(mismatchedSession.externalResourceTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
      expectedSizeBytes: BigInt(body.length + 1),
    });
    expect(mismatchedVideo).toEqual({
      sourceUploadSessionId: null,
      sourceObjectKey: null,
      sourceSizeBytes: null,
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: initialized.uploadSession.bucket,
        objectKey: initialized.uploadSession.objectKey,
      }),
    ).resolves.toMatchObject({
      sizeBytes: body.length,
    });
  });

  test('redirects a reconciled size mismatch durably without the HTTP completion catch', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-mismatch-crash@example.com',
      username: 'video_mismatch_crash',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Mismatch crash window',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const body = Buffer.from('actual source is larger than its declared reservation');
    const declaredSizeBytes = body.length - 1;
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: declaredSizeBytes,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    const uploadResponse = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body,
    });
    const etag = uploadResponse.headers.get('etag');

    expect(uploadResponse.status).toBe(200);
    expect(etag).not.toBeNull();

    const session = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
      where: { id: initialized.uploadSession.id },
      select: {
        externalResourceTargetId: true,
      },
    });
    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.$transaction([
      runtime.prisma.videoUploadSession.update({
        where: { id: initialized.uploadSession.id },
        data: { status: 'completing' },
      }),
      runtime.prisma.videoUploadPart.create({
        data: {
          uploadSessionId: initialized.uploadSession.id,
          partNumber: 1,
          etag: etag ?? '',
        },
      }),
      runtime.prisma.externalResourceTarget.update({
        where: { id: session.externalResourceTargetId },
        data: { nextAttemptAt: dueAt },
      }),
    ]);

    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 0,
      redirectedAbsent: 0,
      failed: 1,
    });

    const mismatched = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
      where: { id: initialized.uploadSession.id },
      select: {
        status: true,
        externalResourceTarget: {
          select: {
            expectedSizeBytes: true,
            goal: true,
            quiescenceNotBefore: true,
            state: true,
          },
        },
      },
    });

    expect(mismatched).toMatchObject({
      status: 'aborting',
      externalResourceTarget: {
        expectedSizeBytes: BigInt(body.length),
        goal: 'absent',
        quiescenceNotBefore: expect.any(Date),
        state: 'quiescing',
      },
    });

    await runtime.prisma.externalResourceTarget.update({
      where: { id: session.externalResourceTargetId },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: initialized.uploadSession.id },
        select: {
          status: true,
          externalResourceTarget: {
            select: {
              expectedSizeBytes: true,
              state: true,
            },
          },
        },
      }),
    ).resolves.toEqual({
      status: 'aborted',
      externalResourceTarget: {
        expectedSizeBytes: BigInt(body.length),
        state: 'confirmed_absent',
      },
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: initialized.uploadSession.bucket,
        objectKey: initialized.uploadSession.objectKey,
      }),
    ).resolves.toBeNull();
  });

  test('finalizes a source reservation crash before S3 initialization as aborted', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-initializing-crash@example.com',
      username: 'video_init_crash',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Initializing crash window',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const uploadSessionId = randomUUID();
    const objectKey = videoOriginalKey(owner.userId, created.video.id, uploadSessionId);
    const reservedAt = new Date();
    const target = await runtime.prisma.$transaction(async (tx) => {
      const reservedTarget = await tx.externalResourceTarget.create({
        data: {
          userId: owner.userId,
          videoId: created.video.id,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          selector: objectKey,
          selectorKind: 'exact',
          role: 'source',
          generation: uploadSessionId,
          expectedSizeBytes: 128n,
          mayHaveMultipartUpload: true,
          goal: 'present',
          state: 'writing',
          nextAttemptAt: reservedAt,
        },
        select: { id: true },
      });
      await tx.videoUploadSession.create({
        data: {
          id: uploadSessionId,
          videoId: created.video.id,
          userId: owner.userId,
          status: 'initializing',
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          objectKey,
          partSizeBytes: 67_108_864,
          expectedSizeBytes: 128n,
          expiresAt: new Date(reservedAt.getTime() + 60 * 60 * 1000),
          externalResourceTargetId: reservedTarget.id,
        },
      });
      await tx.video.update({
        where: { id: created.video.id },
        data: { processingStatus: 'uploading' },
      });

      return reservedTarget;
    });

    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 0,
      redirectedAbsent: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: uploadSessionId },
        select: {
          status: true,
          externalResourceTarget: {
            select: {
              goal: true,
              quiescenceNotBefore: true,
              state: true,
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      status: 'initializing',
      externalResourceTarget: {
        goal: 'absent',
        quiescenceNotBefore: expect.any(Date),
        state: 'quiescing',
      },
    });

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: { id: target.id },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: uploadSessionId },
        select: {
          abortedAt: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      abortedAt: expect.any(Date),
      status: 'aborted',
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: { processingStatus: true },
      }),
    ).resolves.toEqual({ processingStatus: 'draft' });
  });
});
