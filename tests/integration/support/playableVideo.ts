import type { VideoVisibility } from '@prisma/client';
import type { TestRuntime } from './runtime.js';
import { uploadVideoSource } from './fixtures.js';
import { seedHlsGeneration } from './videoArtifacts.js';

export type PlayableVideo = {
  id: string;
  publicId: string;
  createdAt: Date;
  generationId: string;
  publishedAt: Date;
  sourceUploadSessionId: string;
  transcodeJobId: string;
};

export const createPlayableVideo = async (
  runtime: TestRuntime,
  {
    ownerId,
    title,
    visibility,
  }: {
    ownerId: string;
    title: string;
    visibility: VideoVisibility;
  },
): Promise<PlayableVideo> => {
  const created = await runtime.videosService.createVideo({
    userId: ownerId,
    title,
    description: '00:00 Intro 00:05 The cool thing 00:17 End.',
    tags: ['zoo', 'elephants'],
    license: 'cc_by',
    visibility,
    allowComments: true,
  });
  const source = await uploadVideoSource(runtime.videosService, {
    body: Buffer.from(`source for ${title}`),
    userId: ownerId,
    videoId: created.video.id,
  });
  const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
    where: {
      videoId: created.video.id,
      sourceObjectKey: source.uploadSession.objectKey,
    },
    select: { id: true },
  });
  const generation = await seedHlsGeneration(runtime, {
    segmentBody: Buffer.from(`segment for ${title}`),
    sourceUploadSessionId: source.uploadSession.id,
    state: 'active',
    transcodeJobId: job.id,
    userId: ownerId,
    videoId: created.video.id,
  });
  const publishedAt = new Date('2026-06-01T12:00:00.000Z');
  const video = await runtime.prisma.video.update({
    where: { id: created.video.id },
    data: {
      activeArtifactGenerationId: generation.generationId,
      hlsMasterObjectKey: generation.manifest.master.objectKey,
      thumbnailObjectKey: generation.manifest.thumbnail.objectKey,
      processingStatus: 'ready',
      moderationStatus: 'approved',
      visibility,
      publishedAt,
    },
    select: {
      id: true,
      publicId: true,
      createdAt: true,
    },
  });

  return {
    ...video,
    generationId: generation.generationId,
    publishedAt,
    sourceUploadSessionId: source.uploadSession.id,
    transcodeJobId: job.id,
  };
};
