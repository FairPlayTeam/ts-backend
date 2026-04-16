import { prisma } from './prisma.js';

type UserVideoStatsDb = Pick<typeof prisma, 'video' | 'user'>;

export const syncUserVideoStats = async (
  db: UserVideoStatsDb,
  userId: string,
): Promise<void> => {
  const [videoCount, videoViews] = await Promise.all([
    db.video.count({ where: { userId } }),
    db.video.aggregate({
      where: { userId },
      _sum: { viewCount: true },
    }),
  ]);

  await db.user.update({
    where: { id: userId },
    data: {
      videoCount,
      totalViews: videoViews._sum.viewCount ?? 0n,
    },
  });
};
