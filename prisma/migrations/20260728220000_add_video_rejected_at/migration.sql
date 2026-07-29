ALTER TABLE "videos"
ADD COLUMN "rejected_at" TIMESTAMP(3);

CREATE INDEX "videos_moderation_status_rejected_at_id_idx"
ON "videos"("moderation_status", "rejected_at", "id");
