import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  PrismaClient,
  VideoArtifactGenerationState,
  VideoRenditionQuality,
} from '@prisma/client';

import {
  buildVideoArtifactManifest,
  videoHlsSegmentObjectKey,
  type VideoObjectKeyQuality,
} from '../../../src/services/videos/videoObjectKeys.js';
import { VIDEO_OBJECT_STORAGE_BUCKET } from './infrastructure.js';
import type { TestRuntime } from './runtime.js';

export const hlsProfileForQuality = (
  quality: VideoObjectKeyQuality,
): {
  persistedQuality: VideoRenditionQuality;
  width: number;
  height: number;
  bandwidth: number;
} => {
  switch (quality) {
    case '240p':
      return {
        persistedQuality: 'p240',
        width: 426,
        height: 240,
        bandwidth: 700_000,
      };
    case '480p':
      return {
        persistedQuality: 'p480',
        width: 854,
        height: 480,
        bandwidth: 1_400_000,
      };
    case '720p':
      return {
        persistedQuality: 'p720',
        width: 1280,
        height: 720,
        bandwidth: 2_800_000,
      };
    case '1080p':
      return {
        persistedQuality: 'p1080',
        width: 1920,
        height: 1080,
        bandwidth: 5_000_000,
      };
  }
};

export const seedHlsGeneration = async (
  runtime: TestRuntime,
  {
    segmentBody,
    sourceUploadSessionId,
    state,
    transcodeJobId,
    userId,
    videoId,
    quality = '480p',
  }: {
    segmentBody: Buffer;
    sourceUploadSessionId: string;
    state: VideoArtifactGenerationState;
    transcodeJobId: string;
    userId: string;
    videoId: string;
    quality?: VideoObjectKeyQuality;
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
    throw new Error('Expected a seeded HLS rendition');
  }

  await runtime.prisma.videoArtifactGeneration.create({
    data: {
      id: generationId,
      videoId,
      sourceUploadSessionId,
      transcodeJobId,
      executionId: randomUUID(),
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      state,
      hlsMasterObjectKey: manifest.master.objectKey,
      thumbnailObjectKey: manifest.thumbnail.objectKey,
      ...(state === 'active' || state === 'retiring' ? { activatedAt: new Date() } : {}),
      ...(state === 'retired' ? { retiredAt: new Date() } : {}),
    },
  });
  await runtime.prisma.videoRendition.create({
    data: {
      artifactGenerationId: generationId,
      quality: profile.persistedQuality,
      width: profile.width,
      height: profile.height,
      bitrate: profile.bandwidth,
      playlistObjectKey: rendition.playlistObjectKey,
      segmentPrefix: rendition.segmentPrefix,
      codec: 'h264',
      container: 'hls',
    },
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
    generationId,
    manifest,
    quality,
    segmentBody,
    segmentName,
  };
};

export const reserveHlsArtifactTargets = async (
  runtime: TestRuntime,
  {
    generationId,
    manifest,
    state,
    userId,
    videoId,
  }: {
    generationId: string;
    manifest: ReturnType<typeof buildVideoArtifactManifest>;
    state: 'writing' | 'confirmed_present';
    userId: string;
    videoId: string;
  },
): Promise<void> => {
  await runtime.prisma.externalResourceTarget.createMany({
    data: [
      {
        userId,
        videoId,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: manifest.hlsPrefix,
        selectorKind: 'prefix',
        role: 'hls_artifacts',
        generation: generationId,
        expectedSizeBytes: null,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state,
      },
      {
        userId,
        videoId,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: manifest.thumbnailPrefix,
        selectorKind: 'prefix',
        role: 'thumbnail_prefix',
        generation: generationId,
        expectedSizeBytes: null,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state,
      },
    ],
  });
};

export const waitForTranscodeJob = async (
  prisma: PrismaClient,
  jobId: string,
): Promise<{
  executionId: string | null;
  lastError: string | null;
  status: 'queued' | 'processing' | 'completed' | 'failed';
}> => {
  const deadline = Date.now() + 40_000;

  while (Date.now() < deadline) {
    const job = await prisma.videoTranscodeJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        executionId: true,
        lastError: true,
        status: true,
      },
    });

    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }

    await delay(200);
  }

  throw new Error('Timed out waiting for the transcode job to finish');
};
