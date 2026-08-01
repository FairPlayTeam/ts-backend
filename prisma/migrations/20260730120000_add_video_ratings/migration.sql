-- The legacy rating columns were introduced as unused zero-valued placeholders:
-- no previous migration, seed, fixture, or application path ever populated them.
-- Abort instead of silently discarding data if a database diverged from that history.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "videos"
        WHERE "rating_average" IS DISTINCT FROM 0
           OR "rating_count" IS DISTINCT FROM 0
    ) THEN
        RAISE EXCEPTION
            'Cannot add video ratings: legacy rating aggregates contain non-zero data';
    END IF;
END;
$$;

-- AlterTable
ALTER TABLE "videos" DROP COLUMN "rating_average",
ADD COLUMN "rating_sum" INTEGER NOT NULL DEFAULT 0;

-- AddCheckConstraints
ALTER TABLE "videos"
ADD CONSTRAINT "videos_rating_sum_nonnegative_check" CHECK ("rating_sum" >= 0),
ADD CONSTRAINT "videos_rating_count_nonnegative_check" CHECK ("rating_count" >= 0),
ADD CONSTRAINT "videos_rating_sum_minimum_check" CHECK (
    "rating_sum"::bigint >= "rating_count"::bigint
),
ADD CONSTRAINT "videos_rating_sum_count_check" CHECK (
    "rating_sum"::bigint <= "rating_count"::bigint * 5
);

-- CreateTable
CREATE TABLE "video_ratings" (
    "user_id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "value" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_ratings_pkey" PRIMARY KEY ("user_id", "video_id"),
    CONSTRAINT "video_ratings_value_check" CHECK ("value" BETWEEN 1 AND 5)
);

-- CreateIndex
CREATE INDEX "video_ratings_video_id_idx" ON "video_ratings"("video_id");

-- AddForeignKey
ALTER TABLE "video_ratings" ADD CONSTRAINT "video_ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_ratings" ADD CONSTRAINT "video_ratings_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
