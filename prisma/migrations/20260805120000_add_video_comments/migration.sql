-- AddColumn
ALTER TABLE "videos"
ADD COLUMN "comment_count" INTEGER NOT NULL DEFAULT 0;

-- AddCheckConstraint
ALTER TABLE "videos"
ADD CONSTRAINT "videos_comment_count_nonnegative_check" CHECK ("comment_count" >= 0);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "author_id" UUID,
    "video_id" UUID NOT NULL,
    "root_id" UUID,
    "replying_to_comment_id" UUID,
    "content" VARCHAR(800),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "comments_lifecycle_state_check" CHECK (
        (
            "content" IS NOT NULL
            AND "deleted_at" IS NULL
            AND "author_id" IS NOT NULL
        )
        OR
        (
            "content" IS NULL
            AND "deleted_at" IS NOT NULL
        )
    ),
    CONSTRAINT "comments_thread_shape_check" CHECK (
        (
            "root_id" IS NULL
            AND "replying_to_comment_id" IS NULL
        )
        OR
        (
            "root_id" IS NOT NULL
            AND "replying_to_comment_id" IS NOT NULL
            AND "root_id" <> "id"
            AND "replying_to_comment_id" <> "id"
        )
    )
);

-- A CHECK cannot compare a comment with another row of this table. The application
-- therefore enforces that root/target rows belong to the same video and thread while
-- holding their locks; public reads repeat the video_id predicate defensively. A
-- composite self-FK would cover only same-video membership, not same-thread membership,
-- and conflicts with the intended partial SET NULL semantics for reply targets.

-- CreateIndex
CREATE INDEX "comments_video_id_root_id_created_at_id_idx"
ON "comments"("video_id", "root_id", "created_at", "id");

-- PostgreSQL does not reliably derive the root-page ordering path through the nullable
-- root_id prefix of the general thread index. This partial index makes the descending
-- (created_at, id) cursor directly seekable without indexing replies a second time.
CREATE INDEX "comments_root_page_created_at_id_idx"
ON "comments"("video_id", "created_at" DESC, "id" DESC)
WHERE "root_id" IS NULL;

-- The general thread index also includes tombstones and roots. Keep the hot public
-- reply path directly seekable in ascending cursor order without a bitmap scan/sort.
CREATE INDEX "comments_active_reply_page_created_at_id_idx"
ON "comments"("video_id", "root_id", "created_at", "id")
WHERE "root_id" IS NOT NULL AND "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "comments_root_id_created_at_id_idx"
ON "comments"("root_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "comments_author_id_idx" ON "comments"("author_id");

-- CreateIndex
CREATE INDEX "comments_author_id_created_at_id_idx"
ON "comments"("author_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "comments_replying_to_comment_id_idx"
ON "comments"("replying_to_comment_id");

-- The personal export streams existing fact tables with bounded user-scoped cursors.
-- Keep their indexes in this migration because comments add the final exported stream
-- and this repository has no deployed migration history to preserve yet.

-- CreateIndex
CREATE INDEX "video_ratings_user_id_created_at_video_id_idx"
ON "video_ratings"("user_id", "created_at", "video_id");

-- CreateIndex
CREATE INDEX "video_views_user_id_viewed_on_video_id_idx"
ON "video_views"("user_id", "viewed_on", "video_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_created_at_id_idx"
ON "sessions"("user_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "comments"
ADD CONSTRAINT "comments_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments"
ADD CONSTRAINT "comments_video_id_fkey"
FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments"
ADD CONSTRAINT "comments_root_id_fkey"
FOREIGN KEY ("root_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments"
ADD CONSTRAINT "comments_replying_to_comment_id_fkey"
FOREIGN KEY ("replying_to_comment_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
