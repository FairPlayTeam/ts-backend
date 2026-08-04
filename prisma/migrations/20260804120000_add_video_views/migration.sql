-- The view counter was introduced as an unused zero-valued placeholder:
-- no previous migration, seed, fixture, or application path ever populated it.
-- Abort instead of inventing fact rows if a database diverged from that history.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "videos"
        WHERE "view_count" IS DISTINCT FROM 0
    ) THEN
        RAISE EXCEPTION
            'Cannot add video views: legacy view counts contain non-zero data';
    END IF;
END;
$$;

-- AddCheckConstraint
ALTER TABLE "videos"
ADD CONSTRAINT "videos_view_count_nonnegative_check" CHECK ("view_count" >= 0);

-- CreateTable
CREATE TABLE "video_views" (
    "user_id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "viewed_on" DATE NOT NULL,

    CONSTRAINT "video_views_pkey" PRIMARY KEY ("user_id", "video_id", "viewed_on")
);

-- CreateIndex
CREATE INDEX "video_views_video_id_idx" ON "video_views"("video_id");

-- AddForeignKey
ALTER TABLE "video_views" ADD CONSTRAINT "video_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_views" ADD CONSTRAINT "video_views_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
