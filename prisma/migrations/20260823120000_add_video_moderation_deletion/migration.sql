CREATE TYPE "VideoDeletionOrigin" AS ENUM ('moderator', 'admin');

ALTER TABLE "videos"
ADD COLUMN "deletion_requested_at" TIMESTAMP(3),
ADD COLUMN "deletion_reason" VARCHAR(1000),
ADD COLUMN "deletion_origin" "VideoDeletionOrigin",
ADD CONSTRAINT "videos_deletion_request_fields_check"
CHECK (
  ("deletion_requested_at" IS NULL AND "deletion_reason" IS NULL AND "deletion_origin" IS NULL)
  OR
  ("deletion_requested_at" IS NOT NULL AND "deletion_reason" IS NOT NULL AND "deletion_origin" IS NOT NULL)
);

CREATE INDEX "videos_deletion_requested_at_id_idx"
ON "videos"("deletion_requested_at", "id");
