import { prisma } from './lib/prisma.js';
import type { VideoTranscodingMaintenancePort } from './services/videos.types.js';
import {
  createVideoArtifactReconciliationHandlers,
  scheduleAbandonedVideoArtifactGenerations,
} from './services/videos/videoTranscodeRunner.js';

const clock = {
  now: () => new Date(),
};

export const videoTranscodingMaintenance: VideoTranscodingMaintenancePort = {
  scheduleAbandonedArtifactGenerations: ({ observedAt }) =>
    scheduleAbandonedVideoArtifactGenerations({ prisma, clock }, { observedAt }),
};

export const videoTranscodingReconciliationHandlers =
  createVideoArtifactReconciliationHandlers(clock);
