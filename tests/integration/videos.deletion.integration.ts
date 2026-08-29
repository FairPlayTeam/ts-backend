import request from 'supertest';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { HOUR_MS } from '../../src/config/constants.js';
import { buildVideoArtifactManifest } from '../../src/services/videos/videoObjectKeys.js';
import { createPng, createVerifiedSession } from './support/fixtures.js';
import { createPlayableVideo } from './support/playableVideo.js';
import {
  hlsProfileForQuality,
  reserveHlsArtifactTargets,
  seedHlsGeneration,
} from './support/videoArtifacts.js';
import {
  createIntegrationApp,
  createIntegrationAdminService,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const waitForBlockedVideoQueries = async (
  prisma: PrismaClient,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [activity] = await prisma.$queryRaw<Array<{ blocked_count: number }>>`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "videos"%'
        AND query LIKE '%FOR UPDATE%'
    `;

    if ((activity?.blocked_count ?? 0) >= expectedCount) {
      return;
    }

    await delay(25);
  }

  throw new Error(`Timed out waiting for ${expectedCount} blocked video queries`);
};

const runOwnerModerationDeletionInterleaving = async (
  runtime: TestRuntime,
  ownerFirst: boolean,
  suffix: string,
) => {
  const owner = await createVerifiedSession(runtime, {
    email: `concurrent-video-owner-${suffix}@example.com`,
    username: `c_${suffix}_o`,
  });
  const moderator = await createVerifiedSession(runtime, {
    email: `concurrent-video-mod-${suffix}@example.com`,
    username: `c_${suffix}_m`,
  });
  await runtime.prisma.user.update({
    where: { id: moderator.userId },
    data: { role: 'moderator' },
  });
  const video = await runtime.videosService.createVideo({
    userId: owner.userId,
    title: `Concurrent deletion ${suffix}`,
    description: null,
    tags: [],
    license: 'all_rights_reserved',
    allowComments: true,
  });
  const app = await createIntegrationApp(runtime);
  const gatePrisma = createPrismaClient(runtime.databaseUrl);
  const gateAcquired = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();
  const gateTransaction = gatePrisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "videos"
        WHERE "id" = CAST(${video.video.id} AS UUID)
        FOR UPDATE
      `;
      gateAcquired.resolve();
      await releaseGate.promise;
    },
    { timeout: 15_000 },
  );

  await Promise.race([
    gateAcquired.promise,
    delay(5_000).then(() => {
      throw new Error('Owner/moderation deletion gate could not be acquired');
    }),
  ]);
  const startOwnerDeletion = () =>
    request(app)
      .delete(`/videos/${video.video.publicId}`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .then((response) => response);
  const startModerationDeletion = () =>
    request(app)
      .post(`/moderation/videos/${video.video.id}/deletion`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ reason: `Concurrent administrative reason ${suffix}.` })
      .then((response) => response);
  let ownerPromise: ReturnType<typeof startOwnerDeletion>;
  let moderationPromise: ReturnType<typeof startModerationDeletion>;

  try {
    if (ownerFirst) {
      ownerPromise = startOwnerDeletion();
      await waitForBlockedVideoQueries(runtime.prisma, 1);
      moderationPromise = startModerationDeletion();
    } else {
      moderationPromise = startModerationDeletion();
      await waitForBlockedVideoQueries(runtime.prisma, 1);
      ownerPromise = startOwnerDeletion();
    }
    await waitForBlockedVideoQueries(runtime.prisma, 2);
  } finally {
    releaseGate.resolve();
    await gateTransaction;
    await gatePrisma.$disconnect();
  }

  const [ownerResponse, moderationResponse] = await Promise.all([ownerPromise, moderationPromise]);

  return { moderationResponse, ownerResponse, videoId: video.video.id };
};

describe('video deletion integration', () => {
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

  test('immediately deletes an owned video, its dependents, and every durable external target', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-deletion-owner@example.com',
      username: 'video_del_owner',
    });
    const participant = await createVerifiedSession(runtime, {
      email: 'video-deletion-participant@example.com',
      username: 'video_del_part',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Owned video deleted immediately',
      visibility: 'public',
    });
    const profile = hlsProfileForQuality('480p');
    const manifest = buildVideoArtifactManifest(owner.userId, video.id, video.generationId, [
      {
        quality: '480p',
        width: profile.width,
        height: profile.height,
        bandwidth: profile.bandwidth,
      },
    ]);
    await reserveHlsArtifactTargets(runtime, {
      generationId: video.generationId,
      manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: video.id,
    });
    const retiringGeneration = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('retiring segment scheduled by owner deletion'),
      sourceUploadSessionId: video.sourceUploadSessionId,
      state: 'retiring',
      transcodeJobId: video.transcodeJobId,
      userId: owner.userId,
      videoId: video.id,
    });
    await reserveHlsArtifactTargets(runtime, {
      generationId: retiringGeneration.generationId,
      manifest: retiringGeneration.manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: video.id,
    });

    // This replacement source is intentionally not completed and therefore is not attached as
    // Video.sourceUploadSession. It is the pre-existing purge gap covered by the common helper.
    const replacement = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: video.id,
      sizeBytes: 1_024,
    });
    const replacementThumbnail = await createPng(640, 360);
    await runtime.videosService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: video.id,
      uploadSessionId: replacement.uploadSession.id,
      file: {
        buffer: replacementThumbnail,
        size: replacementThumbnail.length,
      },
    });

    const comment = await runtime.prisma.comment.create({
      data: {
        authorId: participant.userId,
        videoId: video.id,
        content: 'This dependent comment must cascade.',
      },
      select: { id: true },
    });
    await Promise.all([
      runtime.prisma.videoRating.create({
        data: {
          userId: participant.userId,
          videoId: video.id,
          value: 5,
        },
      }),
      runtime.prisma.videoView.create({
        data: {
          userId: participant.userId,
          videoId: video.id,
          viewedOn: new Date('2026-08-23T00:00:00.000Z'),
        },
      }),
      runtime.prisma.commentLike.create({
        data: {
          userId: owner.userId,
          commentId: comment.id,
        },
      }),
    ]);
    const targetsBeforeDeletion = await runtime.prisma.externalResourceTarget.findMany({
      where: { videoId: video.id },
      select: {
        id: true,
        generation: true,
        role: true,
      },
    });

    expect(targetsBeforeDeletion).toHaveLength(7);
    expect(targetsBeforeDeletion).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ generation: video.generationId, role: 'hls_artifacts' }),
        expect.objectContaining({ generation: video.generationId, role: 'thumbnail_prefix' }),
        expect.objectContaining({
          generation: retiringGeneration.generationId,
          role: 'hls_artifacts',
        }),
        expect.objectContaining({
          generation: retiringGeneration.generationId,
          role: 'thumbnail_prefix',
        }),
        expect.objectContaining({ generation: replacement.uploadSession.id, role: 'source' }),
        expect.objectContaining({
          generation: replacement.uploadSession.id,
          role: 'source_thumbnail',
        }),
      ]),
    );

    const app = await createIntegrationApp(runtime);
    await request(app).get(`/videos/${video.publicId}`).expect(200);
    await request(app).get(`/videos/${video.publicId}/hls/master.m3u8`).expect(200);
    await request(app)
      .delete(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(204)
      .expect('Cache-Control', 'no-store');

    await expect(runtime.prisma.video.findUnique({ where: { id: video.id } })).resolves.toBeNull();
    await expect(
      Promise.all([
        runtime.prisma.comment.count({ where: { videoId: video.id } }),
        runtime.prisma.videoRating.count({ where: { videoId: video.id } }),
        runtime.prisma.videoView.count({ where: { videoId: video.id } }),
        runtime.prisma.videoUploadSession.count({ where: { videoId: video.id } }),
        runtime.prisma.videoTranscodeJob.count({ where: { videoId: video.id } }),
        runtime.prisma.videoArtifactGeneration.count({ where: { videoId: video.id } }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0]);
    await expect(
      runtime.prisma.commentLike.findUnique({
        where: {
          userId_commentId: {
            userId: owner.userId,
            commentId: comment.id,
          },
        },
      }),
    ).resolves.toBeNull();
    const retainedTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: { videoId: video.id },
      select: {
        generation: true,
        goal: true,
        role: true,
        state: true,
      },
    });
    expect(retainedTargets).toHaveLength(targetsBeforeDeletion.length);
    expect(
      retainedTargets.every(({ goal, state }) => goal === 'absent' && state === 'quiescing'),
    ).toBe(true);
    expect(
      retainedTargets.filter(({ generation }) => generation === retiringGeneration.generationId),
    ).toEqual(
      expect.arrayContaining([
        {
          generation: retiringGeneration.generationId,
          goal: 'absent',
          role: 'hls_artifacts',
          state: 'quiescing',
        },
        {
          generation: retiringGeneration.generationId,
          goal: 'absent',
          role: 'thumbnail_prefix',
          state: 'quiescing',
        },
      ]),
    );

    await request(app).get(`/videos/${video.publicId}`).expect(404);
    await request(app).get(`/videos/${video.publicId}/thumbnail`).expect(404);
    await request(app).get(`/videos/${video.publicId}/hls/master.m3u8`).expect(404);
    const feed = await request(app).get('/videos').expect(200);
    const search = await request(app)
      .get('/videos/search')
      .query({ search: 'Owned video deleted immediately' })
      .expect(200);
    const ownerVideos = await request(app)
      .get('/videos/me')
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(200);
    expect(feed.body.videos).toEqual([]);
    expect(search.body.videos).toEqual([]);
    expect(ownerVideos.body.videos).toEqual([]);
    expect(runtime.delivered.videoRejection).toEqual([]);
    expect(runtime.delivered.videoDeletion).toEqual([]);
  });

  test('returns the same 404 to ordinary and privileged users who do not own the video', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-delete-auth-owner@example.com',
      username: 'video_auth_owner',
    });
    const ordinary = await createVerifiedSession(runtime, {
      email: 'video-delete-auth-user@example.com',
      username: 'video_auth_user',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'video-delete-auth-moderator@example.com',
      username: 'video_auth_mod',
    });
    const admin = await createVerifiedSession(runtime, {
      email: 'video-delete-auth-admin@example.com',
      username: 'video_auth_admin',
    });
    await Promise.all([
      runtime.prisma.user.update({
        where: { id: moderator.userId },
        data: { role: 'moderator' },
      }),
      runtime.prisma.user.update({
        where: { id: admin.userId },
        data: { role: 'admin' },
      }),
    ]);
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Owner-only deletion authorization',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    await runtime.prisma.video.update({
      where: { id: created.video.id },
      data: {
        processingStatus: 'processing',
        moderationStatus: 'rejected',
        rejectedAt: new Date(),
      },
    });
    const app = await createIntegrationApp(runtime);

    for (const sessionKey of [ordinary.sessionKey, moderator.sessionKey, admin.sessionKey]) {
      await request(app)
        .delete(`/videos/${created.video.publicId}`)
        .set('Authorization', `Bearer ${sessionKey}`)
        .expect(404)
        .expect({
          error: 'NotFound',
          message: 'Video not found',
        });
    }

    await expect(
      runtime.prisma.video.findUnique({ where: { id: created.video.id } }),
    ).resolves.not.toBeNull();
    await request(app)
      .delete(`/videos/${created.video.publicId}`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(204);
  });

  test('a moderator schedules deletion of an approved video, keeps direct reads, and closes engagement writes', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const deletionRequestedAt = new Date('2026-08-10T12:00:00.000Z');
    const owner = await createVerifiedSession(runtime, {
      email: 'moderation-deletion-owner@example.com',
      username: 'mod_del_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'moderation-deletion-staff@example.com',
      username: 'mod_del_staff',
    });
    const participant = await createVerifiedSession(runtime, {
      email: 'moderation-deletion-participant@example.com',
      username: 'mod_del_part',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Previously discoverable approved video',
      visibility: 'public',
    });
    const existingComment = await runtime.prisma.comment.create({
      data: {
        authorId: owner.userId,
        videoId: video.id,
        content: 'Existing comment before administrative deletion.',
      },
      select: { id: true },
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.delivered,
        () => deletionRequestedAt,
      ),
    });

    const response = await request(app)
      .post(`/moderation/videos/${video.id}/deletion`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ reason: '  A serious post-publication safety violation.  ' })
      .expect(200)
      .expect('Cache-Control', 'no-store');

    expect(response.body.video).toMatchObject({
      id: video.id,
      moderationStatus: 'approved',
      visibility: 'unlisted',
      rejectedAt: null,
      rejectionReason: null,
      deletionRequestedAt: deletionRequestedAt.toISOString(),
      deletionReason: 'A serious post-publication safety violation.',
      deletionOrigin: 'moderator',
    });
    expect(runtime.delivered.videoDeletion).toEqual([
      {
        email: 'moderation-deletion-owner@example.com',
        title: 'Previously discoverable approved video',
        reason: 'A serious post-publication safety violation.',
      },
    ]);
    const repeatedApproval = await request(app)
      .post(`/moderation/videos/${video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(200);
    expect(repeatedApproval.body.video).toMatchObject({
      moderationStatus: 'approved',
      visibility: 'unlisted',
      deletionRequestedAt: deletionRequestedAt.toISOString(),
      deletionReason: 'A serious post-publication safety violation.',
      deletionOrigin: 'moderator',
    });
    const detail = await request(app).get(`/videos/${video.publicId}`).expect(200);
    expect(detail.body.video.commentsOpen).toBe(false);
    expect(detail.body.video).not.toHaveProperty('deletionRequestedAt');
    expect(detail.body.video).not.toHaveProperty('deletionReason');
    expect(detail.body.video).not.toHaveProperty('deletionOrigin');
    await request(app).get(`/videos/${video.publicId}/hls/master.m3u8`).expect(200);
    await request(app).get(`/videos/${video.publicId}/thumbnail`).redirects(0).expect(307);
    const ownerVideos = await request(app)
      .get('/videos/me')
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(200);
    expect(ownerVideos.body.videos).toHaveLength(1);
    expect(ownerVideos.body.videos[0]).not.toHaveProperty('deletionRequestedAt');
    expect(ownerVideos.body.videos[0]).not.toHaveProperty('deletionReason');
    expect(ownerVideos.body.videos[0]).not.toHaveProperty('deletionOrigin');
    const feed = await request(app).get('/videos').expect(200);
    const search = await request(app)
      .get('/videos/search')
      .query({ search: 'Previously discoverable approved video' })
      .expect(200);
    expect(feed.body.videos).toEqual([]);
    expect(search.body.videos).toEqual([]);
    await request(app)
      .post(`/videos/${video.publicId}/comments`)
      .set('Authorization', `Bearer ${participant.sessionKey}`)
      .send({ content: 'Must be blocked while deletion is pending.' })
      .expect(404)
      .expect({ error: 'NotFound', message: 'Video not found' });
    await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${participant.sessionKey}`)
      .send({ value: 5 })
      .expect(404)
      .expect({ error: 'NotFound', message: 'Video not found' });
    await request(app)
      .put(`/videos/${video.publicId}/comments/${existingComment.id}/like`)
      .set('Authorization', `Bearer ${participant.sessionKey}`)
      .expect(404)
      .expect({ error: 'NotFound', message: 'Comment not found' });
  });

  test('the owner can immediately delete a video while administrative deletion is pending', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'pending-deletion-owner@example.com',
      username: 'pending_del_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'pending-deletion-moderator@example.com',
      username: 'pending_del_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Owner overrides pending administrative retention',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const upload = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: video.video.id,
      sizeBytes: 1_024,
    });
    const app = await createIntegrationApp(runtime);

    await request(app)
      .post(`/moderation/videos/${video.video.id}/deletion`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ reason: 'Administrative deletion awaiting retention.' })
      .expect(200);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.video.id },
        select: { deletionRequestedAt: true },
      }),
    ).resolves.toEqual({ deletionRequestedAt: expect.any(Date) });

    await request(app)
      .delete(`/videos/${video.video.publicId}`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(204);

    await expect(
      runtime.prisma.video.findUnique({ where: { id: video.video.id } }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.externalResourceTarget.findFirstOrThrow({
        where: {
          videoId: video.video.id,
          generation: upload.uploadSession.id,
          role: 'source',
        },
        select: { goal: true, state: true },
      }),
    ).resolves.toEqual({ goal: 'absent', state: 'quiescing' });
  });

  test('admin deletion is idempotent across pending and rejected states, and purge uses the oldest deadline', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const oldRejection = new Date('2026-07-30T12:00:00.000Z');
    const firstRequestAt = new Date('2026-08-01T12:00:00.000Z');
    let moderationNow = oldRejection;
    const owner = await createVerifiedSession(runtime, {
      email: 'admin-deletion-states-owner@example.com',
      username: 'admin_del_states',
    });
    const admin = await createVerifiedSession(runtime, {
      email: 'admin-deletion-states-staff@example.com',
      username: 'admin_del_staff',
    });
    await runtime.prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    const pending = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Pending administrative deletion',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const pendingUpload = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: pending.video.id,
      sizeBytes: 1_024,
    });
    const rejected = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Rejected then administratively deleted',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const rejectedUpload = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: rejected.video.id,
      sizeBytes: 1_024,
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.delivered,
        () => moderationNow,
      ),
    });

    await request(app)
      .post(`/moderation/videos/${rejected.video.id}/moderation`)
      .set('Authorization', `Bearer ${admin.sessionKey}`)
      .send({ decision: 'rejected', reason: 'Original rejection remains distinct.' })
      .expect(200);
    expect(runtime.delivered.videoRejection).toEqual([
      {
        email: 'admin-deletion-states-owner@example.com',
        title: 'Rejected then administratively deleted',
        reason: 'Original rejection remains distinct.',
      },
    ]);

    moderationNow = firstRequestAt;
    await request(app)
      .post(`/moderation/videos/${pending.video.id}/deletion`)
      .set('Authorization', `Bearer ${admin.sessionKey}`)
      .send({ reason: 'Pending-state administrative reason.' })
      .expect(200);
    await request(app)
      .post(`/moderation/videos/${rejected.video.id}/deletion`)
      .set('Authorization', `Bearer ${admin.sessionKey}`)
      .send({ reason: 'Administrative reason distinct from rejection.' })
      .expect(200);
    moderationNow = new Date('2026-08-02T12:00:00.000Z');
    const repeated = await request(app)
      .post(`/moderation/videos/${rejected.video.id}/deletion`)
      .set('Authorization', `Bearer ${admin.sessionKey}`)
      .send({ reason: 'Must not replace the first administrative reason.' })
      .expect(200);

    expect(runtime.delivered.videoDeletion).toHaveLength(2);
    expect(
      runtime.delivered.videoDeletion.filter(
        ({ title }) => title === 'Rejected then administratively deleted',
      ),
    ).toEqual([
      {
        email: 'admin-deletion-states-owner@example.com',
        title: 'Rejected then administratively deleted',
        reason: 'Administrative reason distinct from rejection.',
      },
    ]);
    expect(repeated.body.video).toMatchObject({
      moderationStatus: 'rejected',
      rejectedAt: oldRejection.toISOString(),
      rejectionReason: 'Original rejection remains distinct.',
      deletionRequestedAt: firstRequestAt.toISOString(),
      deletionReason: 'Administrative reason distinct from rejection.',
      deletionOrigin: 'admin',
    });

    const observedAt = new Date('2026-08-07T12:00:00.001Z');
    await expect(
      runtime.videosService.deleteExpiredVideosPendingPurge({
        observedAt,
        purgeBefore: new Date(observedAt.getTime() - 7 * 24 * HOUR_MS),
      }),
    ).resolves.toEqual({
      videosPendingPurgeDeleted: 1,
      videoPendingPurgeTargetsScheduled: 1,
    });
    await expect(
      runtime.prisma.video.findUnique({ where: { id: rejected.video.id } }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.video.findUnique({ where: { id: pending.video.id } }),
    ).resolves.not.toBeNull();
    const rejectedTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: { videoId: rejected.video.id },
      select: { generation: true, goal: true, role: true, state: true },
    });
    expect(rejectedTargets).toEqual([
      {
        generation: rejectedUpload.uploadSession.id,
        goal: 'absent',
        role: 'source',
        state: 'quiescing',
      },
    ]);
    await expect(
      runtime.videosService.deleteExpiredVideosPendingPurge({
        observedAt,
        purgeBefore: new Date(observedAt.getTime() - 7 * 24 * HOUR_MS),
      }),
    ).resolves.toEqual({
      videosPendingPurgeDeleted: 0,
      videoPendingPurgeTargetsScheduled: 0,
    });

    const afterPurge = await request(app)
      .post(`/moderation/videos/${rejected.video.id}/deletion`)
      .set('Authorization', `Bearer ${admin.sessionKey}`)
      .send({ reason: 'Already physically deleted.' })
      .expect(404);
    expect(afterPurge.body).toEqual({ error: 'NotFound', message: 'Video not found' });
    expect(runtime.delivered.videoDeletion).toHaveLength(2);

    const finalObservedAt = new Date('2026-08-09T12:00:00.001Z');
    await expect(
      runtime.videosService.deleteExpiredVideosPendingPurge({
        observedAt: finalObservedAt,
        purgeBefore: new Date(finalObservedAt.getTime() - 7 * 24 * HOUR_MS),
      }),
    ).resolves.toEqual({
      videosPendingPurgeDeleted: 1,
      videoPendingPurgeTargetsScheduled: 1,
    });
    await expect(
      runtime.prisma.video.findUnique({ where: { id: pending.video.id } }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.externalResourceTarget.findFirstOrThrow({
        where: {
          videoId: pending.video.id,
          generation: pendingUpload.uploadSession.id,
          role: 'source',
        },
        select: { goal: true, state: true },
      }),
    ).resolves.toEqual({ goal: 'absent', state: 'quiescing' });
  });

  test('purges the oldest effective deadline before lower UUIDs when candidates exceed the batch', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'purge-fairness-owner@example.com',
      username: 'purge_fairness',
    });
    const observedAt = new Date('2026-08-24T12:00:00.000Z');
    const purgeBefore = new Date(observedAt.getTime() - 7 * 24 * HOUR_MS);
    const barelyExpiredAt = new Date(purgeBefore.getTime() - 1);
    const longExpiredAt = new Date(purgeBefore.getTime() - 30 * 24 * HOUR_MS);
    const longExpiredHighId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const barelyExpiredLowIds = Array.from(
      { length: 100 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    const lastBarelyExpiredLowId = barelyExpiredLowIds.at(-1);

    if (!lastBarelyExpiredLowId) {
      throw new Error('Expected a barely-expired candidate at the batch boundary');
    }

    await runtime.prisma.video.createMany({
      data: [
        {
          id: longExpiredHighId,
          publicId: 'OldPurge01',
          ownerId: owner.userId,
          title: 'Long-expired high UUID administrative deletion',
          moderationStatus: 'approved',
          deletionRequestedAt: longExpiredAt,
          deletionReason: 'Old administrative deletion must not starve.',
          deletionOrigin: 'admin',
        },
        ...barelyExpiredLowIds.map((id, index) => ({
          id,
          publicId: `P${String(index + 1).padStart(9, '0')}`,
          ownerId: owner.userId,
          title: `Barely-expired low UUID rejection ${index + 1}`,
          moderationStatus: 'rejected' as const,
          rejectedAt: barelyExpiredAt,
          rejectionReason: 'Recent rejection behind the older effective deadline.',
        })),
      ],
    });

    await expect(
      runtime.videosService.deleteExpiredVideosPendingPurge({ observedAt, purgeBefore }),
    ).resolves.toEqual({
      videosPendingPurgeDeleted: 100,
      videoPendingPurgeTargetsScheduled: 0,
    });

    const remainingCandidates = await runtime.prisma.video.findMany({
      where: {
        id: {
          in: [longExpiredHighId, ...barelyExpiredLowIds],
        },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    expect(remainingCandidates).toEqual([{ id: lastBarelyExpiredLowId }]);
    await expect(
      runtime.prisma.video.findUnique({ where: { id: longExpiredHighId } }),
    ).resolves.toBeNull();
  });

  test.each([
    { ownerFirst: true, suffix: 'owner_first' },
    { ownerFirst: false, suffix: 'mod_first' },
  ])(
    'serializes owner hard deletion against administrative deletion ($suffix)',
    async ({ ownerFirst, suffix }) => {
      if (!runtime) {
        throw new Error('Integration runtime was not started');
      }

      const result = await runOwnerModerationDeletionInterleaving(runtime, ownerFirst, suffix);

      expect(result.ownerResponse.status).toBe(204);

      if (ownerFirst) {
        expect(result.moderationResponse.status).toBe(404);
        expect(result.moderationResponse.body).toEqual({
          error: 'NotFound',
          message: 'Video not found',
        });
        expect(runtime.delivered.videoDeletion).toEqual([]);
      } else {
        expect(result.moderationResponse.status).toBe(200);
        expect(runtime.delivered.videoDeletion).toEqual([
          {
            email: 'concurrent-video-owner-mod_first@example.com',
            title: 'Concurrent deletion mod_first',
            reason: 'Concurrent administrative reason mod_first.',
          },
        ]);
      }

      await expect(
        runtime.prisma.video.findUnique({ where: { id: result.videoId } }),
      ).resolves.toBeNull();
    },
  );

  test('the existing rejected-video purge now schedules an unattached initializing source', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'rejected-upload-purge-owner@example.com',
      username: 'reject_upload_purge',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Rejected during source upload',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const upload = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: 1_024,
    });
    const observedAt = new Date('2026-08-23T12:00:00.000Z');
    const rejectedAt = new Date(observedAt.getTime() - 8 * 24 * HOUR_MS);
    await runtime.prisma.video.update({
      where: { id: created.video.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt,
      },
    });

    await expect(
      runtime.videosService.deleteExpiredVideosPendingPurge({
        observedAt,
        purgeBefore: new Date(observedAt.getTime() - 7 * 24 * HOUR_MS),
      }),
    ).resolves.toEqual({
      videosPendingPurgeDeleted: 1,
      videoPendingPurgeTargetsScheduled: 1,
    });
    await expect(
      runtime.prisma.video.findUnique({ where: { id: created.video.id } }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.externalResourceTarget.findFirstOrThrow({
        where: {
          videoId: created.video.id,
          generation: upload.uploadSession.id,
          role: 'source',
        },
        select: { goal: true, state: true },
      }),
    ).resolves.toEqual({ goal: 'absent', state: 'quiescing' });
  });
});
