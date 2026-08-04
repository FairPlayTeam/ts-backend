import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthPorts } from '../../src/services/auth.types.js';
import type { VideosService } from '../../src/services/videos.types.js';
import { createPng, createVerifiedSession } from './support/fixtures.js';
import { createPlayableVideo, type PlayableVideo } from './support/playableVideo.js';
import { seedHlsGeneration } from './support/videoArtifacts.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const createVideoReadBarrierService = (
  runtime: TestRuntime,
  afterVideoRead: () => Promise<void>,
): VideosService => {
  const barrierPrisma = {
    $executeRaw: (query: Prisma.Sql) => runtime.prisma.$executeRaw(query),
    $transaction: async <T>(
      run: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<T> =>
      runtime.prisma.$transaction(async (tx) => {
        const barrierTransaction = {
          video: {
            findFirst: async (args: unknown) => {
              const video = await tx.video.findFirst(args as never);
              await afterVideoRead();

              return video;
            },
          },
          videoRating: tx.videoRating,
        } as unknown as Prisma.TransactionClient;

        return run(barrierTransaction);
      }, options),
  } as unknown as PrismaClient;

  return createIntegrationVideosService(
    barrierPrisma,
    runtime.videoObjectStorage,
    runtime.videoExternalResources,
  );
};

describe('public video detail integration', () => {
  let runtime: TestRuntime | null = null;
  let app: Awaited<ReturnType<typeof createIntegrationApp>>;
  let owner: Awaited<ReturnType<typeof createVerifiedSession>>;
  let rater: Awaited<ReturnType<typeof createVerifiedSession>>;
  let secondRater: Awaited<ReturnType<typeof createVerifiedSession>>;
  let unratedUser: Awaited<ReturnType<typeof createVerifiedSession>>;
  let expiredUser: Awaited<ReturnType<typeof createVerifiedSession>>;
  let revokedUser: Awaited<ReturnType<typeof createVerifiedSession>>;
  let moderator: Awaited<ReturnType<typeof createVerifiedSession>>;
  let publicVideo: PlayableVideo;
  let unlistedVideo: PlayableVideo;
  let rejectedVideo: PlayableVideo;
  let nonReadyVideo: PlayableVideo;
  let missingGenerationPublicId: string;

  beforeAll(async () => {
    runtime = await startRuntime();
    await resetState(runtime);
    app = await createIntegrationApp(runtime);
    owner = await createVerifiedSession(runtime, {
      email: 'jawed@example.com',
      username: 'jawed',
    });
    rater = await createVerifiedSession(runtime, {
      email: 'video-detail-rater@example.com',
      username: 'detail_rater',
    });
    secondRater = await createVerifiedSession(runtime, {
      email: 'video-detail-second-rater@example.com',
      username: 'detail_rater_two',
    });
    unratedUser = await createVerifiedSession(runtime, {
      email: 'video-detail-unrated@example.com',
      username: 'detail_unrated',
    });
    expiredUser = await createVerifiedSession(runtime, {
      email: 'video-detail-expired@example.com',
      username: 'detail_expired',
    });
    revokedUser = await createVerifiedSession(runtime, {
      email: 'video-detail-revoked@example.com',
      username: 'detail_revoked',
    });
    moderator = await createVerifiedSession(runtime, {
      email: 'video-detail-moderator@example.com',
      username: 'detail_moderator',
    });
    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { displayName: 'Jawed Karim' },
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    await runtime.prisma.session.updateMany({
      where: { userId: expiredUser.userId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await runtime.prisma.session.updateMany({
      where: { userId: revokedUser.userId },
      data: { isActive: false },
    });
    const avatar = await createPng();
    await runtime.authService.uploadAvatar({
      userId: owner.userId,
      file: { buffer: avatar, size: avatar.length },
    });

    publicVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Me at the zoo',
      visibility: 'public',
    });
    unlistedVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Unlisted playable detail',
      visibility: 'unlisted',
    });
    rejectedVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Rejected but playable detail',
      visibility: 'public',
    });
    nonReadyVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Non-ready detail',
      visibility: 'public',
    });
    await runtime.prisma.video.update({
      where: { id: nonReadyVideo.id },
      data: { processingStatus: 'processing' },
    });
    const missingGeneration = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Ready without generation',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: true,
    });
    await runtime.prisma.video.update({
      where: { id: missingGeneration.video.id },
      data: {
        processingStatus: 'ready',
        moderationStatus: 'approved',
        publishedAt: new Date('2026-06-01T12:00:00.000Z'),
      },
    });
    missingGenerationPublicId = missingGeneration.video.publicId;

    await request(app)
      .put(`/videos/${publicVideo.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 4 })
      .expect(200);
    await request(app)
      .put(`/videos/${publicVideo.publicId}/rating`)
      .set('Authorization', `Bearer ${secondRater.sessionKey}`)
      .send({ value: 5 })
      .expect(200);
    await request(app)
      .put(`/videos/${rejectedVideo.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 3 })
      .expect(200);
    await runtime.prisma.video.update({
      where: { id: rejectedVideo.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await stopRuntime(runtime);
  });

  test('returns the complete playable public detail without internal fields', async () => {
    const response = await request(app)
      .get(`/videos/${publicVideo.publicId}`)
      .expect(200)
      .expect('Cache-Control', 'no-store');

    expect(response.body).toEqual({
      video: {
        publicId: publicVideo.publicId,
        title: 'Me at the zoo',
        description: '00:00 Intro 00:05 The cool thing 00:17 End.',
        tags: ['zoo', 'elephants'],
        license: 'cc_by',
        visibility: 'public',
        createdAt: publicVideo.createdAt.toISOString(),
        publishedAt: publicVideo.publishedAt.toISOString(),
        creator: {
          username: 'jawed',
          displayName: 'Jawed Karim',
          avatarUrl: '/profiles/jawed/avatar',
        },
        ratingAverage: 4.5,
        ratingCount: 2,
        userRating: null,
        viewCount: 0,
        hlsMasterPath: `/videos/${publicVideo.publicId}/hls/master.m3u8`,
      },
    });
    expect(Object.keys(response.body.video).sort()).toEqual(
      [
        'createdAt',
        'creator',
        'description',
        'hlsMasterPath',
        'license',
        'publicId',
        'publishedAt',
        'ratingAverage',
        'ratingCount',
        'tags',
        'title',
        'userRating',
        'viewCount',
        'visibility',
      ].sort(),
    );
    expect(Object.keys(response.body.video.creator).sort()).toEqual(
      ['avatarUrl', 'displayName', 'username'].sort(),
    );
    await request(app)
      .get(response.body.video.hlsMasterPath as string)
      .expect(200);
  });

  test('keeps unlisted and rejected ready videos directly playable', async () => {
    const [unlisted, rejected] = await Promise.all([
      request(app).get(`/videos/${unlistedVideo.publicId}`),
      request(app).get(`/videos/${rejectedVideo.publicId}`),
    ]);

    expect(unlisted.status).toBe(200);
    expect(unlisted.body.video.visibility).toBe('unlisted');
    expect(rejected.status).toBe(200);
    expect(rejected.body.video.title).toBe('Rejected but playable detail');
    expect(rejected.body.video).not.toHaveProperty('moderationStatus');
  });

  test('keeps rejected video rating reads coherent while refusing new writes', async () => {
    const [detail, aggregate, mine] = await Promise.all([
      request(app).get(`/videos/${rejectedVideo.publicId}`).expect(200),
      request(app).get(`/videos/${rejectedVideo.publicId}/rating`).expect(200),
      request(app)
        .get(`/videos/${rejectedVideo.publicId}/rating/me`)
        .set('Authorization', `Bearer ${rater.sessionKey}`)
        .expect(200),
    ]);

    expect({
      ratingAverage: detail.body.video.ratingAverage,
      ratingCount: detail.body.video.ratingCount,
    }).toEqual({ ratingAverage: 3, ratingCount: 1 });
    expect(aggregate.body).toEqual({ ratingAverage: 3, ratingCount: 1 });
    expect(mine.body).toEqual({ ratingAverage: 3, ratingCount: 1, userRating: 3 });
    await request(app)
      .put(`/videos/${rejectedVideo.publicId}/rating`)
      .set('Authorization', `Bearer ${unratedUser.sessionKey}`)
      .send({ value: 5 })
      .expect(404)
      .expect({ error: 'NotFound', message: 'Video not found' });
  });

  test('returns one uniform 404 for non-ready videos and missing active generations', async () => {
    const [nonReady, missingGeneration, unknownVideo] = await Promise.all([
      request(app).get(`/videos/${nonReadyVideo.publicId}`),
      request(app).get(`/videos/${missingGenerationPublicId}`),
      request(app).get('/videos/Missng123_'),
    ]);

    expect(nonReady.status).toBe(404);
    expect(missingGeneration.status).toBe(404);
    expect(unknownVideo.status).toBe(404);
    expect(nonReady.body).toEqual({ error: 'NotFound', message: 'Video not found' });
    expect(missingGeneration.body).toEqual(nonReady.body);
    expect(unknownVideo.body).toEqual(nonReady.body);
  });

  test('returns the current user rating or null for every optional-auth state', async () => {
    const [rated, unrated, anonymous, malformed, invalid, expired, revoked] = await Promise.all([
      request(app)
        .get(`/videos/${publicVideo.publicId}`)
        .set('Authorization', `Bearer ${rater.sessionKey}`),
      request(app)
        .get(`/videos/${publicVideo.publicId}`)
        .set('Authorization', `Bearer ${unratedUser.sessionKey}`),
      request(app).get(`/videos/${publicVideo.publicId}`),
      request(app)
        .get(`/videos/${publicVideo.publicId}`)
        .set('Authorization', 'Basic malformed-session-token'),
      request(app)
        .get(`/videos/${publicVideo.publicId}`)
        .set('Authorization', 'Bearer invalid-session-token'),
      request(app)
        .get(`/videos/${publicVideo.publicId}`)
        .set('Authorization', `Bearer ${expiredUser.sessionKey}`),
      request(app)
        .get(`/videos/${publicVideo.publicId}`)
        .set('Authorization', `Bearer ${revokedUser.sessionKey}`),
    ]);

    expect([
      rated.status,
      unrated.status,
      anonymous.status,
      malformed.status,
      invalid.status,
      expired.status,
      revoked.status,
    ]).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(rated.body.video.userRating).toBe(4);
    expect(unrated.body.video.userRating).toBeNull();
    expect(anonymous.body.video.userRating).toBeNull();
    expect(malformed.body.video.userRating).toBeNull();
    expect(invalid.body.video.userRating).toBeNull();
    expect(expired.body.video.userRating).toBeNull();
    expect(revoked.body.video.userRating).toBeNull();
  });

  test('returns one coherent snapshot when the owner is deleted after the video read', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const raceOwner = await createVerifiedSession(runtime, {
      email: 'video-detail-owner-delete@example.com',
      username: 'detail_owner_delete',
    });
    const raceVideo = await createPlayableVideo(runtime, {
      ownerId: raceOwner.userId,
      title: 'Owner deletion detail race',
      visibility: 'public',
    });
    const videoRead = Promise.withResolvers<void>();
    const releaseVideoRead = Promise.withResolvers<void>();
    const barrierService = createVideoReadBarrierService(runtime, async () => {
      videoRead.resolve();
      await releaseVideoRead.promise;
    });
    const barrierApp = await createIntegrationApp(runtime, { videosService: barrierService });
    const pendingDetail = request(barrierApp)
      .get(`/videos/${raceVideo.publicId}`)
      .then((response) => response);

    await videoRead.promise;
    try {
      await runtime.prisma.user.delete({ where: { id: raceOwner.userId } });
    } finally {
      releaseVideoRead.resolve();
    }
    const detail = await pendingDetail;

    expect(detail.status).toBe(200);
    expect(detail.body.video.creator.username).toBe('detail_owner_delete');
    await request(app)
      .get(`/videos/${raceVideo.publicId}`)
      .expect(404)
      .expect({ error: 'NotFound', message: 'Video not found' });
  });

  test('degrades to an unrated viewer when the authenticated account is deleted before the detail snapshot', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const deletedViewer = await createVerifiedSession(runtime, {
      email: 'video-detail-viewer-delete@example.com',
      username: 'detail_viewer_delete',
    });
    const raceVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Viewer deletion detail race',
      visibility: 'public',
    });
    await request(app)
      .put(`/videos/${raceVideo.publicId}/rating`)
      .set('Authorization', `Bearer ${deletedViewer.sessionKey}`)
      .send({ value: 4 })
      .expect(200);
    const sessionValidated = Promise.withResolvers<void>();
    const releaseValidation = Promise.withResolvers<void>();
    const authService = runtime.authService;
    const barrierAuthService: AuthPorts = {
      ...authService,
      validateSession: async (sessionKey) => {
        const result = await authService.validateSession(sessionKey);
        sessionValidated.resolve();
        await releaseValidation.promise;

        return result;
      },
    };
    const barrierApp = await createIntegrationApp(runtime, { authService: barrierAuthService });
    const pendingDetail = request(barrierApp)
      .get(`/videos/${raceVideo.publicId}`)
      .set('Authorization', `Bearer ${deletedViewer.sessionKey}`)
      .then((response) => response);

    await sessionValidated.promise;
    try {
      await runtime.prisma.user.delete({ where: { id: deletedViewer.userId } });
    } finally {
      releaseValidation.resolve();
    }
    const detail = await pendingDetail;

    expect(detail.status).toBe(200);
    expect(detail.body.video.ratingAverage).toBe(4);
    expect(detail.body.video.ratingCount).toBe(1);
    expect(detail.body.video.userRating).toBeNull();
  });

  test('linearizes a committed vote between the detail and dedicated rating reads', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const raceVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Rating read linearization race',
      visibility: 'public',
    });
    await request(app)
      .put(`/videos/${raceVideo.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 2 })
      .expect(200);
    const videoRead = Promise.withResolvers<void>();
    const releaseVideoRead = Promise.withResolvers<void>();
    const barrierService = createVideoReadBarrierService(runtime, async () => {
      videoRead.resolve();
      await releaseVideoRead.promise;
    });
    const barrierApp = await createIntegrationApp(runtime, { videosService: barrierService });
    const pendingDetail = request(barrierApp)
      .get(`/videos/${raceVideo.publicId}`)
      .then((response) => response);

    await videoRead.promise;
    const dedicatedRatingBody: unknown = await (async () => {
      try {
        await request(app)
          .put(`/videos/${raceVideo.publicId}/rating`)
          .set('Authorization', `Bearer ${secondRater.sessionKey}`)
          .send({ value: 5 })
          .expect(200);

        return (await request(app).get(`/videos/${raceVideo.publicId}/rating`).expect(200)).body;
      } finally {
        releaseVideoRead.resolve();
      }
    })();
    const detail = await pendingDetail;

    expect({
      ratingAverage: detail.body.video.ratingAverage,
      ratingCount: detail.body.video.ratingCount,
    }).toEqual({ ratingAverage: 2, ratingCount: 1 });
    expect(dedicatedRatingBody).toEqual({ ratingAverage: 3.5, ratingCount: 2 });
  });

  test('keeps the stable master path valid across publication during the detail snapshot', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const raceVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Generation publication detail race',
      visibility: 'public',
    });
    const nextGeneration = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('replacement generation segment'),
      sourceUploadSessionId: raceVideo.sourceUploadSessionId,
      state: 'writing',
      transcodeJobId: raceVideo.transcodeJobId,
      userId: owner.userId,
      videoId: raceVideo.id,
    });
    const videoRead = Promise.withResolvers<void>();
    const releaseVideoRead = Promise.withResolvers<void>();
    const barrierService = createVideoReadBarrierService(runtime, async () => {
      videoRead.resolve();
      await releaseVideoRead.promise;
    });
    const barrierApp = await createIntegrationApp(runtime, { videosService: barrierService });
    const pendingDetail = request(barrierApp)
      .get(`/videos/${raceVideo.publicId}`)
      .then((response) => response);

    await videoRead.promise;
    try {
      await runtime.prisma.$transaction(async (tx) => {
        await tx.videoArtifactGeneration.update({
          where: { id: raceVideo.generationId },
          data: { state: 'retiring' },
        });
        await tx.videoArtifactGeneration.update({
          where: { id: nextGeneration.generationId },
          data: { state: 'active', activatedAt: new Date() },
        });
        await tx.video.update({
          where: { id: raceVideo.id },
          data: {
            activeArtifactGenerationId: nextGeneration.generationId,
            hlsMasterObjectKey: nextGeneration.manifest.master.objectKey,
            thumbnailObjectKey: nextGeneration.manifest.thumbnail.objectKey,
          },
        });
      });
    } finally {
      releaseVideoRead.resolve();
    }
    const detail = await pendingDetail;

    expect(detail.status).toBe(200);
    expect(detail.body.video.hlsMasterPath).toBe(`/videos/${raceVideo.publicId}/hls/master.m3u8`);
    const master = await request(app)
      .get(detail.body.video.hlsMasterPath as string)
      .expect(200);
    expect(master.text).toContain(
      `/videos/${raceVideo.publicId}/hls/${nextGeneration.generationId}/480p/index.m3u8`,
    );
  });

  test('keeps a missing creator avatar best-effort', async () => {
    await runtime?.prisma.userMediaAsset.deleteMany({
      where: { userId: owner.userId, kind: 'avatar' },
    });

    const response = await request(app).get(`/videos/${unlistedVideo.publicId}`).expect(200);

    expect(response.body.video.creator).toEqual({
      username: 'jawed',
      displayName: 'Jawed Karim',
      avatarUrl: null,
    });
    expect(response.body.video.hlsMasterPath).toBe(
      `/videos/${unlistedVideo.publicId}/hls/master.m3u8`,
    );
  });

  test('does not expose privileged fields to a moderator on the public route', async () => {
    const response = await request(app)
      .get(`/videos/${publicVideo.publicId}`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);

    expect(Object.keys(response.body.video).sort()).toEqual(
      [
        'createdAt',
        'creator',
        'description',
        'hlsMasterPath',
        'license',
        'publicId',
        'publishedAt',
        'ratingAverage',
        'ratingCount',
        'tags',
        'title',
        'userRating',
        'viewCount',
        'visibility',
      ].sort(),
    );
  });

  test('matches the dedicated rating aggregate for the same video', async () => {
    const [detail, rating] = await Promise.all([
      request(app).get(`/videos/${publicVideo.publicId}`).expect(200),
      request(app).get(`/videos/${publicVideo.publicId}/rating`).expect(200),
    ]);

    expect({
      ratingAverage: detail.body.video.ratingAverage,
      ratingCount: detail.body.video.ratingCount,
    }).toEqual(rating.body);
  });
});
