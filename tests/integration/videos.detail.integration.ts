import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AuthPorts } from '../../src/services/auth.types.js';
import { createPng, createVerifiedSession, uploadVideoSource } from './support/fixtures.js';
import { createPlayableVideo, type PlayableVideo } from './support/playableVideo.js';
import { seedHlsGeneration } from './support/videoArtifacts.js';
import {
  createIntegrationApp,
  createVideoReadBarrierService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';
import { coordinateWhilePaused } from './support/asyncBarriers.js';
import { waitForVideoViewState } from './support/videoViews.js';

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
  let optionalAuthVideo: PlayableVideo;
  let moderatorVideo: PlayableVideo;
  let avatarlessVideo: PlayableVideo;
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
    optionalAuthVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Optional authentication detail',
      visibility: 'public',
    });
    moderatorVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Moderator public detail',
      visibility: 'public',
    });
    const avatarlessOwner = await createVerifiedSession(runtime, {
      email: 'video-detail-avatarless@example.com',
      username: 'detail_avatarless',
    });
    await runtime.prisma.user.update({
      where: { id: avatarlessOwner.userId },
      data: { displayName: 'Avatarless Creator' },
    });
    avatarlessVideo = await createPlayableVideo(runtime, {
      ownerId: avatarlessOwner.userId,
      title: 'Avatarless creator detail',
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
      allowComments: true,
    });
    await runtime.prisma.video.update({
      where: { id: missingGeneration.video.id },
      data: {
        processingStatus: 'ready',
        durationSeconds: 19,
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
      .put(`/videos/${optionalAuthVideo.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 4 })
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
        commentsOpen: true,
        createdAt: publicVideo.createdAt.toISOString(),
        publishedAt: publicVideo.publishedAt.toISOString(),
        thumbnailPath: `/videos/${publicVideo.publicId}/thumbnail`,
        creator: {
          username: 'jawed',
          displayName: 'Jawed Karim',
          avatarUrl: '/profiles/jawed/avatar',
        },
        ratingAverage: 4.5,
        ratingCount: 2,
        userRating: null,
        viewCount: 0,
        commentCount: 0,
        duration: 19,
        hlsMasterPath: `/videos/${publicVideo.publicId}/hls/master.m3u8`,
      },
    });
    expect(Object.keys(response.body.video).sort()).toEqual(
      [
        'commentsOpen',
        'commentCount',
        'createdAt',
        'creator',
        'description',
        'duration',
        'hlsMasterPath',
        'license',
        'publicId',
        'publishedAt',
        'ratingAverage',
        'ratingCount',
        'tags',
        'thumbnailPath',
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
    expect(rejected.body.video.commentsOpen).toBe(false);
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
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const [rated, unrated, anonymous, malformed, invalid, expired, revoked] = await Promise.all([
      request(app)
        .get(`/videos/${optionalAuthVideo.publicId}`)
        .set('Authorization', `Bearer ${rater.sessionKey}`),
      request(app)
        .get(`/videos/${optionalAuthVideo.publicId}`)
        .set('Authorization', `Bearer ${unratedUser.sessionKey}`),
      request(app).get(`/videos/${optionalAuthVideo.publicId}`),
      request(app)
        .get(`/videos/${optionalAuthVideo.publicId}`)
        .set('Authorization', 'Basic malformed-session-token'),
      request(app)
        .get(`/videos/${optionalAuthVideo.publicId}`)
        .set('Authorization', 'Bearer invalid-session-token'),
      request(app)
        .get(`/videos/${optionalAuthVideo.publicId}`)
        .set('Authorization', `Bearer ${expiredUser.sessionKey}`),
      request(app)
        .get(`/videos/${optionalAuthVideo.publicId}`)
        .set('Authorization', `Bearer ${revokedUser.sessionKey}`),
    ]);
    await waitForVideoViewState(runtime.prisma, optionalAuthVideo.id, 2);

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
    const activeRuntime = runtime;

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

    const [detail] = await coordinateWhilePaused({
      firstBarrierDescription: 'the owner-deletion detail video read',
      firstOperation: pendingDetail,
      firstPaused: videoRead.promise,
      releaseFirst: releaseVideoRead.resolve,
      runWhilePaused: () => activeRuntime.prisma.user.delete({ where: { id: raceOwner.userId } }),
      whilePausedDescription: 'the owner deletion during the detail snapshot',
    });

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
    const activeRuntime = runtime;

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

    const [detail] = await coordinateWhilePaused({
      firstBarrierDescription: 'the deleted-viewer session validation',
      firstOperation: pendingDetail,
      firstPaused: sessionValidated.promise,
      releaseFirst: releaseValidation.resolve,
      runWhilePaused: () =>
        activeRuntime.prisma.user.delete({ where: { id: deletedViewer.userId } }),
      whilePausedDescription: 'the viewer deletion before the detail snapshot',
    });

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
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .then((response) => response);

    const [detail, dedicatedRatingBody] = await coordinateWhilePaused({
      firstBarrierDescription: 'the rating-linearization detail video read',
      firstOperation: pendingDetail,
      firstPaused: videoRead.promise,
      releaseFirst: releaseVideoRead.resolve,
      runWhilePaused: async () => {
        await request(app)
          .put(`/videos/${raceVideo.publicId}/rating`)
          .set('Authorization', `Bearer ${rater.sessionKey}`)
          .send({ value: 5 })
          .expect(200);

        const ratingBody: unknown = (
          await request(app).get(`/videos/${raceVideo.publicId}/rating`).expect(200)
        ).body;

        return ratingBody;
      },
      whilePausedDescription: 'the committed rating and dedicated aggregate read',
    });

    expect({
      ratingAverage: detail.body.video.ratingAverage,
      ratingCount: detail.body.video.ratingCount,
      userRating: detail.body.video.userRating,
    }).toEqual({ ratingAverage: 2, ratingCount: 1, userRating: 2 });
    expect(dedicatedRatingBody).toEqual({ ratingAverage: 5, ratingCount: 1 });
  });

  test('keeps the stable master path valid across publication during the detail snapshot', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

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

    const [detail] = await coordinateWhilePaused({
      firstBarrierDescription: 'the generation-publication detail video read',
      firstOperation: pendingDetail,
      firstPaused: videoRead.promise,
      releaseFirst: releaseVideoRead.resolve,
      runWhilePaused: () =>
        activeRuntime.prisma.$transaction(async (tx) => {
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
        }),
      whilePausedDescription: 'the replacement generation publication',
    });

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
    const response = await request(app).get(`/videos/${avatarlessVideo.publicId}`).expect(200);

    expect(response.body.video.creator).toEqual({
      username: 'detail_avatarless',
      displayName: 'Avatarless Creator',
      avatarUrl: null,
    });
    expect(response.body.video.hlsMasterPath).toBe(
      `/videos/${avatarlessVideo.publicId}/hls/master.m3u8`,
    );
  });

  test('does not expose privileged fields to a moderator on the public route', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const response = await request(app)
      .get(`/videos/${moderatorVideo.publicId}`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    await waitForVideoViewState(runtime.prisma, moderatorVideo.id, 1);

    expect(Object.keys(response.body.video).sort()).toEqual(
      [
        'commentsOpen',
        'commentCount',
        'createdAt',
        'creator',
        'description',
        'duration',
        'hlsMasterPath',
        'license',
        'publicId',
        'publishedAt',
        'ratingAverage',
        'ratingCount',
        'tags',
        'thumbnailPath',
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

  test('persists the upload-time comment preference and exposes its effective public state', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const cases = [
      { title: 'Upload comments explicitly enabled', requestValue: true, expected: true },
      { title: 'Upload comments explicitly disabled', requestValue: false, expected: false },
      { title: 'Upload comments default enabled', requestValue: undefined, expected: true },
    ] as const;

    for (const testCase of cases) {
      const createResponse = await request(app)
        .post('/videos')
        .set('Authorization', `Bearer ${owner.sessionKey}`)
        .send({
          title: testCase.title,
          ...(testCase.requestValue === undefined ? {} : { allowComments: testCase.requestValue }),
        })
        .expect(201);
      const created = createResponse.body.video as {
        allowComments: boolean;
        id: string;
        publicId: string;
      };

      expect(created.allowComments).toBe(testCase.expected);

      const source = await uploadVideoSource(runtime.videosService, {
        body: Buffer.from(`source for ${testCase.title}`),
        userId: owner.userId,
        videoId: created.id,
      });
      const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
        where: {
          videoId: created.id,
          sourceObjectKey: source.uploadSession.objectKey,
        },
        select: { id: true },
      });
      const generation = await seedHlsGeneration(runtime, {
        segmentBody: Buffer.from(`segment for ${testCase.title}`),
        sourceUploadSessionId: source.uploadSession.id,
        state: 'active',
        transcodeJobId: job.id,
        userId: owner.userId,
        videoId: created.id,
      });
      await runtime.prisma.video.update({
        where: { id: created.id },
        data: {
          activeArtifactGenerationId: generation.generationId,
          hlsMasterObjectKey: generation.manifest.master.objectKey,
          thumbnailObjectKey: generation.manifest.thumbnail.objectKey,
          processingStatus: 'ready',
          moderationStatus: 'approved',
          visibility: 'public',
          publishedAt: new Date('2026-06-01T12:00:00.000Z'),
          durationSeconds: 19,
        },
      });

      const [persisted, detail] = await Promise.all([
        runtime.prisma.video.findUniqueOrThrow({
          where: { id: created.id },
          select: { allowComments: true },
        }),
        request(app).get(`/videos/${created.publicId}`).expect(200),
      ]);

      expect(persisted.allowComments).toBe(testCase.expected);
      expect(detail.body.video.commentsOpen).toBe(testCase.expected);
    }
  });
});
