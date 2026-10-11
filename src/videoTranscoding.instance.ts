import { prisma } from './lib/prisma.js';
import type { VideoTranscodingMaintenancePort } from './modules/videoTranscoding/index.js';
import {
  createVideoArtifactReconciliationHandlers,
  scheduleAbandonedVideoArtifactGenerations,
} from './modules/videoTranscoding/index.js';

const clock = {
  now: () => new Date(),
};

export const videoTranscodingMaintenance: VideoTranscodingMaintenancePort = {
  scheduleAbandonedArtifactGenerations: ({ observedAt }) =>
    scheduleAbandonedVideoArtifactGenerations({ prisma, clock }, { observedAt }),
};

export const videoTranscodingReconciliationHandlers =
  createVideoArtifactReconciliationHandlers(clock);
