import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';

export const waitForVideoViewState = async (
  prisma: PrismaClient,
  videoId: string,
  expectedCount: number,
): Promise<void> => {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const [video, facts] = await Promise.all([
      prisma.video.findUniqueOrThrow({
        where: { id: videoId },
        select: { viewCount: true },
      }),
      prisma.videoView.count({ where: { videoId } }),
    ]);

    if (video.viewCount === expectedCount && facts === expectedCount) {
      return;
    }

    await delay(25);
  }

  throw new Error(`Timed out waiting for video ${videoId} to reach ${expectedCount} views`);
};
