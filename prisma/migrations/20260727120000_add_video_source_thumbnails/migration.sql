ALTER TYPE "ExternalResourceRole" ADD VALUE 'source_thumbnail';

ALTER TABLE "external_resource_targets"
  DROP CONSTRAINT "external_resource_targets_expected_size_check",
  DROP CONSTRAINT "external_resource_targets_selector_role_check";

ALTER TABLE "external_resource_targets"
  ADD CONSTRAINT "external_resource_targets_expected_size_check"
    CHECK (
      (
        "role" IN ('source', 'source_thumbnail', 'user_media')
        AND "expected_size_bytes" > 0
      )
      OR
      (
        "role" NOT IN ('source', 'source_thumbnail', 'user_media')
        AND "expected_size_bytes" IS NULL
      )
    ),
  ADD CONSTRAINT "external_resource_targets_selector_role_check"
    CHECK (
      (
        "role" IN ('source', 'source_thumbnail', 'user_media')
        AND "selector_kind" = 'exact'
      )
      OR
      (
        "role" IN ('hls_artifacts', 'thumbnail_prefix')
        AND "selector_kind" = 'prefix'
      )
    );

CREATE TABLE "video_source_thumbnails" (
  "id" UUID NOT NULL,
  "upload_session_id" UUID NOT NULL,
  "external_resource_target_id" UUID NOT NULL,
  "bucket" VARCHAR(128) NOT NULL,
  "object_key" VARCHAR(512) NOT NULL,
  "mime_type" VARCHAR(100) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "video_source_thumbnails_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "video_source_thumbnails_size_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "video_source_thumbnails_dimensions_check" CHECK ("width" > 0 AND "height" > 0)
);

CREATE UNIQUE INDEX "video_source_thumbnails_upload_session_id_key"
  ON "video_source_thumbnails"("upload_session_id");
CREATE UNIQUE INDEX "video_source_thumbnails_external_resource_target_id_key"
  ON "video_source_thumbnails"("external_resource_target_id");
CREATE UNIQUE INDEX "video_source_thumbnails_object_key_key"
  ON "video_source_thumbnails"("object_key");

ALTER TABLE "video_source_thumbnails"
  ADD CONSTRAINT "video_source_thumbnails_upload_session_id_fkey"
  FOREIGN KEY ("upload_session_id") REFERENCES "video_upload_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "video_source_thumbnails"
  ADD CONSTRAINT "video_source_thumbnails_external_resource_target_id_fkey"
  FOREIGN KEY ("external_resource_target_id") REFERENCES "external_resource_targets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
