import { Prisma } from '@prisma/client';

type VideoViewWriter = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type RecordVideoViewInput = {
  userId: string;
  videoId: string;
  viewedOn: string;
};

export const toUtcVideoViewDay = (date: Date): string => date.toISOString().slice(0, 10);

export const recordVideoView = async (
  prisma: VideoViewWriter,
  { userId, videoId, viewedOn }: RecordVideoViewInput,
): Promise<boolean> => {
  const updatedVideos = await prisma.$executeRaw(
    Prisma.sql`
      WITH inserted_view AS (
        INSERT INTO "video_views" ("user_id", "video_id", "viewed_on")
        SELECT
          CAST(${userId} AS UUID),
          v."id",
          CAST(${viewedOn} AS DATE)
        FROM "videos" AS v
        WHERE v."id" = CAST(${videoId} AS UUID)
          AND v."owner_id" <> CAST(${userId} AS UUID)
        ON CONFLICT ("user_id", "video_id", "viewed_on") DO NOTHING
        RETURNING "video_id"
      )
      UPDATE "videos" AS v
      SET "view_count" = v."view_count" + 1
      FROM inserted_view AS inserted
      WHERE v."id" = inserted."video_id"
    `,
  );

  return updatedVideos === 1;
};
