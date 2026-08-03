import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  buildVideoArtifactManifest,
  videoHlsSegmentObjectKey,
  type VideoObjectKeyQuality,
} from '../../src/services/videos/videoObjectKeys.js';
import {
  claimNextVideoTranscodeJob,
  publishVideoArtifactGeneration,
  type ClaimedVideoTranscodeJob,
} from '../../src/services/videos/videoTranscodeRunner.js';
import { createExternalResourceReconciler } from '../../src/services/externalResources.js';
import { HOUR_MS } from '../../src/config/constants.js';
import { createVerifiedSession, uploadVideoSource } from './support/fixtures.js';
import {
  hlsProfileForQuality,
  reserveHlsArtifactTargets,
  seedHlsGeneration,
} from './support/videoArtifacts.js';
import { VIDEO_OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

const prepareHlsGenerationForPublication = async (
  runtime: TestRuntime,
  {
    job,
    quality = '480p',
    segmentBody,
    sourceUploadSessionId,
    userId,
    videoId,
  }: {
    job: ClaimedVideoTranscodeJob;
    quality?: VideoObjectKeyQuality;
    segmentBody: Buffer;
    sourceUploadSessionId: string;
    userId: string;
    videoId: string;
  },
) => {
  const generationId = randomUUID();
  const profile = hlsProfileForQuality(quality);
  const manifest = buildVideoArtifactManifest(userId, videoId, generationId, [
    {
      quality,
      width: profile.width,
      height: profile.height,
      bandwidth: profile.bandwidth,
    },
  ]);
  const rendition = manifest.renditions[0];

  if (!rendition) {
    throw new Error('Expected a publishable HLS rendition');
  }

  await runtime.prisma.videoArtifactGeneration.create({
    data: {
      id: generationId,
      videoId,
      sourceUploadSessionId,
      transcodeJobId: job.id,
      executionId: job.executionId,
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      state: 'writing',
    },
  });
  await reserveHlsArtifactTargets(runtime, {
    generationId,
    manifest,
    state: 'writing',
    userId,
    videoId,
  });

  const segmentName = 'segment-00000.ts';
  await Promise.all([
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: manifest.master.objectKey,
      body: Buffer.from(
        '#EXTM3U\n' +
          '#EXT-X-VERSION:3\n' +
          `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${profile.width}x${profile.height},CODECS="avc1.4d401f,mp4a.40.2"\n` +
          `${quality}/index.m3u8\n`,
      ),
      contentType: 'application/vnd.apple.mpegurl',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: rendition.playlistObjectKey,
      body: Buffer.from(
        '#EXTM3U\n' +
          '#EXT-X-VERSION:6\n' +
          '#EXT-X-TARGETDURATION:6\n' +
          '#EXT-X-MEDIA-SEQUENCE:0\n' +
          '#EXTINF:6.000000,\n' +
          `segments/${segmentName}\n` +
          '#EXT-X-ENDLIST\n',
      ),
      contentType: 'application/vnd.apple.mpegurl',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: videoHlsSegmentObjectKey(rendition, segmentName),
      body: segmentBody,
      contentType: 'video/mp2t',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: manifest.thumbnail.objectKey,
      body: Buffer.from('test thumbnail bytes'),
      contentType: 'image/webp',
    }),
  ]);

  return {
    generation: {
      id: generationId,
      sourceUploadSessionId,
      userId,
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
    },
    generationId,
    manifest,
    quality,
    segmentName,
  };
};

describe('videos HLS integration', () => {
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

  test('serves public generation-scoped HLS safely through PostgreSQL and MinIO', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'public-hls@example.com',
      username: 'public_hls',
    });
    const firstVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Public HLS first video',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const firstSource = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('first HLS source'),
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const firstJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: firstVideo.video.id,
        sourceObjectKey: firstSource.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const active = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('active segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'active',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const retiring = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('retiring segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'retiring',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const writing = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('writing segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'writing',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const retired = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('retired segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'retired',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: {
        activeArtifactGenerationId: active.generationId,
        hlsMasterObjectKey: active.manifest.master.objectKey,
        thumbnailObjectKey: active.manifest.thumbnail.objectKey,
        processingStatus: 'ready',
      },
    });

    const secondVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Public HLS second video',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const secondSource = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('second HLS source'),
      userId: owner.userId,
      videoId: secondVideo.video.id,
    });
    const secondJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: secondVideo.video.id,
        sourceObjectKey: secondSource.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const otherVideoGeneration = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('other video 720p segment bytes'),
      sourceUploadSessionId: secondSource.uploadSession.id,
      state: 'active',
      transcodeJobId: secondJob.id,
      userId: owner.userId,
      videoId: secondVideo.video.id,
      quality: '720p',
    });
    await runtime.prisma.video.update({
      where: { id: secondVideo.video.id },
      data: {
        activeArtifactGenerationId: otherVideoGeneration.generationId,
        hlsMasterObjectKey: otherVideoGeneration.manifest.master.objectKey,
        thumbnailObjectKey: otherVideoGeneration.manifest.thumbnail.objectKey,
        processingStatus: 'ready',
      },
    });

    const masterPath = `/videos/${firstVideo.video.publicId}/hls/master.m3u8`;
    const activeRenditionPath = `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/index.m3u8`;
    const activeSegmentPath = `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${active.segmentName}`;
    const thumbnailPath = `/videos/${firstVideo.video.publicId}/thumbnail`;
    const masterResponse = await request(app).get(masterPath).expect(200);

    expect(masterResponse.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/u);
    expect(masterResponse.headers['cache-control']).toBe('no-cache');
    expect(masterResponse.text).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"',
    );
    expect(masterResponse.text).toContain(activeRenditionPath);
    expect(masterResponse.text).not.toContain('\n480p/index.m3u8');

    const renditionResponse = await request(app).get(activeRenditionPath).expect(200);

    expect(renditionResponse.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/u);
    expect(renditionResponse.headers['cache-control']).toBe('no-cache');
    expect(renditionResponse.text).toContain('#EXTINF:6.000000,');
    expect(renditionResponse.text).toContain(activeSegmentPath);

    const segmentRedirect = await request(app).get(activeSegmentPath).redirects(0).expect(307);
    const signedSegmentUrl = segmentRedirect.headers.location as string | undefined;

    expect(segmentRedirect.headers['cache-control']).toBe('no-store');
    expect(signedSegmentUrl).toBeDefined();
    expect(new URL(signedSegmentUrl ?? '').origin).toBe(runtime.objectStorageConfig.publicUrl);
    const segmentResponse = await fetch(signedSegmentUrl ?? '');
    expect(segmentResponse.status).toBe(200);
    expect(Buffer.from(await segmentResponse.arrayBuffer())).toEqual(active.segmentBody);
    const thumbnailRedirect = await request(app).get(thumbnailPath).redirects(0).expect(307);
    const signedThumbnailUrl = thumbnailRedirect.headers.location as string | undefined;

    expect(thumbnailRedirect.headers['cache-control']).toBe('no-store');
    expect(signedThumbnailUrl).toBeDefined();
    const thumbnailResponse = await fetch(signedThumbnailUrl ?? '');
    expect(thumbnailResponse.status).toBe(200);
    expect(Buffer.from(await thumbnailResponse.arrayBuffer())).toEqual(
      Buffer.from('test thumbnail bytes'),
    );

    const notFoundBody = {
      error: 'NotFound',
      message: 'Video not found',
    };
    const unavailableResponses = await Promise.all([
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${otherVideoGeneration.generationId}/720p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/720p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${writing.generationId}/480p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${retired.generationId}/480p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/segment-99999.ts`,
      ),
    ]);

    for (const response of unavailableResponses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFoundBody);
    }

    const retiringRenditionPath = `/videos/${firstVideo.video.publicId}/hls/${retiring.generationId}/480p/index.m3u8`;
    await request(app).get(retiringRenditionPath).expect(200).expect('Cache-Control', 'no-cache');

    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { role: 'moderator' },
    });
    await request(app)
      .post(`/moderation/videos/${firstVideo.video.id}/moderation`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .send({ decision: 'rejected', reason: 'Video policy violation.' })
      .expect(200);
    const rejectedReadableResponses = await Promise.all([
      request(app).get(thumbnailPath).redirects(0),
      request(app).get(masterPath),
      request(app).get(activeRenditionPath),
      request(app).get(activeSegmentPath).redirects(0),
    ]);
    expect(rejectedReadableResponses.map(({ status }) => status)).toEqual([307, 200, 200, 307]);

    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: {
        moderationStatus: 'pending',
        processingStatus: 'processing',
      },
    });
    const processingResponse = await request(app).get(masterPath);
    expect(processingResponse.status).toBe(404);
    expect(processingResponse.body).toEqual(notFoundBody);
    await request(app).get(thumbnailPath).expect(404).expect(notFoundBody);

    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: { processingStatus: 'ready' },
    });
    const invalidPaths = [
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480P/index.m3u8`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/${encodeURIComponent('../480p')}/index.m3u8`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/${encodeURIComponent('/480p')}/index.m3u8`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/segment-0000.ts`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${encodeURIComponent('../segment-00000.ts')}`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${encodeURIComponent('/segment-00000.ts')}`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${encodeURIComponent('C:\\segment-00000.ts')}`,
    ];

    for (const path of invalidPaths) {
      const response = await request(app).get(path);
      expect(response.status).toBe(404);
    }

    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: { visibility: 'public' },
    });
    await request(app).get(masterPath).expect(200);
  });

  test('expires generation-qualified HLS after a controlled one-hour retirement window', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'hls-retention@example.com',
      username: 'hls_retention',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'HLS retirement clock',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('source for controlled HLS retirement'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const storedJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: {
        id: true,
      },
    });
    const generationA = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('generation A segment'),
      sourceUploadSessionId: source.uploadSession.id,
      state: 'active',
      transcodeJobId: storedJob.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await reserveHlsArtifactTargets(runtime, {
      generationId: generationA.generationId,
      manifest: generationA.manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: created.video.id,
    });
    await runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: generationA.manifest.thumbnail.objectKey,
      body: Buffer.from('generation A thumbnail'),
      contentType: 'image/webp',
    });
    await runtime.prisma.video.update({
      where: { id: created.video.id },
      data: {
        activeArtifactGenerationId: generationA.generationId,
        hlsMasterObjectKey: generationA.manifest.master.objectKey,
        thumbnailObjectKey: generationA.manifest.thumbnail.objectKey,
        processingStatus: 'ready',
      },
    });

    const masterPath = `/videos/${created.video.publicId}/hls/master.m3u8`;
    const oldRenditionPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/index.m3u8`;
    const oldSegmentPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/segments/${generationA.segmentName}`;
    const masterA = await request(app).get(masterPath).expect(200);

    expect(masterA.text).toContain(oldRenditionPath);

    let controlledNow = new Date();
    const claimedJob = await claimNextVideoTranscodeJob({
      prisma: runtime.prisma,
      clock: { now: () => controlledNow },
    });

    expect(claimedJob?.id).toBe(storedJob.id);

    if (!claimedJob) {
      throw new Error('Expected the source transcode job to be claimed');
    }

    const generationB = await prepareHlsGenerationForPublication(runtime, {
      job: claimedJob,
      segmentBody: Buffer.from('generation B segment'),
      sourceUploadSessionId: source.uploadSession.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await publishVideoArtifactGeneration(
      {
        prisma: runtime.prisma,
        clock: { now: () => controlledNow },
      },
      {
        generation: generationB.generation,
        job: claimedJob,
        manifest: generationB.manifest,
        probe: {
          width: 854,
          height: 480,
          durationSeconds: 6,
          hasAudio: true,
        },
      },
    );

    const retirementTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        generation: generationA.generationId,
      },
      select: {
        goal: true,
        quiescenceNotBefore: true,
        state: true,
      },
    });
    expect(retirementTargets).toHaveLength(2);
    expect(
      retirementTargets.every(
        (target) =>
          target.goal === 'absent' &&
          target.state === 'quiescing' &&
          target.quiescenceNotBefore?.getTime() === controlledNow.getTime() + HOUR_MS,
      ),
    ).toBe(true);

    controlledNow = new Date(controlledNow.getTime() + HOUR_MS + 1);
    const controlledExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => controlledNow },
      logger: testLogger,
    });
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      controlledExternalResources,
      { now: () => controlledNow },
    );
    await expect(
      controlledVideosService.reconcilePendingExternalResources(),
    ).resolves.toMatchObject({
      confirmed: 2,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: { id: generationA.generationId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'retired' });

    const notFoundBody = {
      error: 'NotFound',
      message: 'Video not found',
    };
    const [oldRendition, oldSegment] = await Promise.all([
      request(app).get(oldRenditionPath),
      request(app).get(oldSegmentPath).redirects(0),
    ]);

    expect(oldRendition.status).toBe(404);
    expect(oldRendition.body).toEqual(notFoundBody);
    expect(oldSegment.status).toBe(404);
    expect(oldSegment.body).toEqual(notFoundBody);
    await request(app)
      .get(masterPath)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain(
          `/videos/${created.video.publicId}/hls/${generationB.generationId}/480p/index.m3u8`,
        );
      });
  });

  test('interrupts HLS after a real source replacement until its generation is published', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'hls-source-replacement@example.com',
      username: 'hls_source_replace',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'HLS source replacement',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceA = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('first source for HLS replacement'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const firstJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: sourceA.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const generationA = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('first generation segment'),
      sourceUploadSessionId: sourceA.uploadSession.id,
      state: 'active',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await reserveHlsArtifactTargets(runtime, {
      generationId: generationA.generationId,
      manifest: generationA.manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: created.video.id,
    });
    await runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: generationA.manifest.thumbnail.objectKey,
      body: Buffer.from('first generation thumbnail'),
      contentType: 'image/webp',
    });
    await runtime.prisma.$transaction([
      runtime.prisma.videoTranscodeJob.update({
        where: { id: firstJob.id },
        data: {
          status: 'completed',
          attempts: 1,
          completedAt: new Date(),
        },
      }),
      runtime.prisma.video.update({
        where: { id: created.video.id },
        data: {
          activeArtifactGenerationId: generationA.generationId,
          hlsMasterObjectKey: generationA.manifest.master.objectKey,
          thumbnailObjectKey: generationA.manifest.thumbnail.objectKey,
          processingStatus: 'ready',
        },
      }),
    ]);

    const masterPath = `/videos/${created.video.publicId}/hls/master.m3u8`;
    const oldRenditionPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/index.m3u8`;
    const oldSegmentPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/segments/${generationA.segmentName}`;
    await request(app).get(masterPath).expect(200);
    await request(app).get(oldRenditionPath).expect(200);
    await request(app).get(oldSegmentPath).redirects(0).expect(307);

    const sourceB = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('replacement source with different bytes'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: {
          activeArtifactGenerationId: true,
          processingStatus: true,
          sourceUploadSessionId: true,
        },
      }),
    ).resolves.toEqual({
      activeArtifactGenerationId: generationA.generationId,
      processingStatus: 'queued',
      sourceUploadSessionId: sourceB.uploadSession.id,
    });

    const notFoundBody = {
      error: 'NotFound',
      message: 'Video not found',
    };
    const unavailableDuringReplacement = await Promise.all([
      request(app).get(masterPath),
      request(app).get(oldRenditionPath),
      request(app).get(oldSegmentPath).redirects(0),
    ]);

    for (const response of unavailableDuringReplacement) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFoundBody);
    }

    const publicationAt = new Date();
    const claimedReplacementJob = await claimNextVideoTranscodeJob({
      prisma: runtime.prisma,
      clock: { now: () => publicationAt },
    });

    expect(claimedReplacementJob?.sourceObjectKey).toBe(sourceB.uploadSession.objectKey);

    if (!claimedReplacementJob) {
      throw new Error('Expected the replacement source transcode job to be claimed');
    }

    const generationB = await prepareHlsGenerationForPublication(runtime, {
      job: claimedReplacementJob,
      segmentBody: Buffer.from('replacement generation segment'),
      sourceUploadSessionId: sourceB.uploadSession.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await publishVideoArtifactGeneration(
      {
        prisma: runtime.prisma,
        clock: { now: () => publicationAt },
      },
      {
        generation: generationB.generation,
        job: claimedReplacementJob,
        manifest: generationB.manifest,
        probe: {
          width: 854,
          height: 480,
          durationSeconds: 6,
          hasAudio: true,
        },
      },
    );

    const newRenditionPath = `/videos/${created.video.publicId}/hls/${generationB.generationId}/480p/index.m3u8`;
    const newSegmentPath = `/videos/${created.video.publicId}/hls/${generationB.generationId}/480p/segments/${generationB.segmentName}`;
    await request(app)
      .get(masterPath)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain(newRenditionPath);
      });
    await request(app).get(newRenditionPath).expect(200);
    await request(app).get(newSegmentPath).redirects(0).expect(307);
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: { id: generationA.generationId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'retiring' });
  });
});
