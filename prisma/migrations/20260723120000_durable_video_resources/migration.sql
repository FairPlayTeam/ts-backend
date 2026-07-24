-- CreateEnum
CREATE TYPE "VideoArtifactGenerationState" AS ENUM ('writing', 'active', 'retiring', 'retired');

-- CreateEnum
CREATE TYPE "ExternalResourceSelectorKind" AS ENUM ('exact', 'prefix');

-- CreateEnum
CREATE TYPE "ExternalResourceGoal" AS ENUM ('present', 'absent');

-- CreateEnum
CREATE TYPE "ExternalResourceState" AS ENUM ('writing', 'quiescing', 'reconciling', 'confirmed_present', 'confirmed_absent');

-- CreateEnum
CREATE TYPE "ExternalResourceRole" AS ENUM ('source', 'hls_artifacts', 'thumbnail_prefix', 'user_media');

-- ReplaceEnum
CREATE TYPE "VideoRenditionQuality_new" AS ENUM ('480p', '720p', '1080p');
ALTER TABLE "video_renditions"
  ALTER COLUMN "quality" TYPE "VideoRenditionQuality_new"
  USING ("quality"::text::"VideoRenditionQuality_new");
DROP TYPE "VideoRenditionQuality";
ALTER TYPE "VideoRenditionQuality_new" RENAME TO "VideoRenditionQuality";

-- ReplaceEnum
ALTER TABLE "video_upload_sessions" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "VideoUploadSessionStatus_new" AS ENUM (
  'initializing',
  'initiated',
  'uploading',
  'completing',
  'completed',
  'aborting',
  'aborted',
  'expiring',
  'expired'
);
ALTER TABLE "video_upload_sessions"
  ALTER COLUMN "status" TYPE "VideoUploadSessionStatus_new"
  USING ("status"::text::"VideoUploadSessionStatus_new");
DROP TYPE "VideoUploadSessionStatus";
ALTER TYPE "VideoUploadSessionStatus_new" RENAME TO "VideoUploadSessionStatus";

-- DropForeignKey
ALTER TABLE "video_renditions" DROP CONSTRAINT "video_renditions_video_id_fkey";

-- DropIndex
DROP INDEX "video_renditions_video_id_quality_key";

-- DropIndex
DROP INDEX "video_transcode_jobs_lease_expires_at_idx";

-- DropIndex
DROP INDEX "video_upload_sessions_bucket_object_key_upload_id_key";

-- AlterTable
ALTER TABLE "user_media_assets"
  ADD COLUMN "bucket" VARCHAR(128) NOT NULL,
  ADD COLUMN "external_resource_target_id" UUID NOT NULL;

-- DropTable
DROP TABLE "user_media_deletion_jobs";

-- AlterTable
ALTER TABLE "video_renditions"
  DROP COLUMN "video_id",
  ADD COLUMN "artifact_generation_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "video_transcode_jobs"
  DROP COLUMN "lease_expires_at",
  DROP COLUMN "leased_by",
  ADD COLUMN "execution_id" UUID,
  ADD COLUMN "heartbeat_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "video_upload_sessions"
  DROP COLUMN "upload_id",
  ADD COLUMN "expected_size_bytes" BIGINT NOT NULL,
  ADD COLUMN "expired_at" TIMESTAMP(3),
  ADD COLUMN "external_resource_target_id" UUID NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'initializing';

-- AlterTable
ALTER TABLE "videos"
  DROP COLUMN "legacy_qualities",
  DROP COLUMN "legacy_storage_path",
  ADD COLUMN "active_artifact_generation_id" UUID,
  ADD COLUMN "source_size_bytes" BIGINT,
  ADD COLUMN "source_upload_session_id" UUID;

-- CreateTable
CREATE TABLE "video_artifact_generations" (
  "id" UUID NOT NULL,
  "video_id" UUID NOT NULL,
  "source_upload_session_id" UUID NOT NULL,
  "transcode_job_id" UUID NOT NULL,
  "execution_id" UUID NOT NULL,
  "bucket" VARCHAR(128) NOT NULL,
  "state" "VideoArtifactGenerationState" NOT NULL DEFAULT 'writing',
  "hls_master_object_key" VARCHAR(512),
  "thumbnail_object_key" VARCHAR(512),
  "activated_at" TIMESTAMP(3),
  "retired_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "video_artifact_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_resource_targets" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "video_id" UUID,
  "bucket" VARCHAR(128) NOT NULL,
  "selector" VARCHAR(512) NOT NULL,
  "selector_kind" "ExternalResourceSelectorKind" NOT NULL,
  "role" "ExternalResourceRole" NOT NULL,
  "generation" VARCHAR(128) NOT NULL,
  "expected_size_bytes" BIGINT,
  "may_have_multipart_upload" BOOLEAN NOT NULL DEFAULT false,
  "goal" "ExternalResourceGoal" NOT NULL DEFAULT 'present',
  "state" "ExternalResourceState" NOT NULL DEFAULT 'writing',
  "quiescence_not_before" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" VARCHAR(1000),
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconciliation_lease_id" UUID,
  "reconciliation_lease_expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "external_resource_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_resource_targets_nonempty_selector_check"
    CHECK (length("selector") > 0 AND length("bucket") > 0 AND length("generation") > 0),
  CONSTRAINT "external_resource_targets_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "external_resource_targets_expected_size_check"
    CHECK (
      ("role" IN ('source', 'user_media') AND "expected_size_bytes" > 0)
      OR
      ("role" NOT IN ('source', 'user_media') AND "expected_size_bytes" IS NULL)
    ),
  CONSTRAINT "external_resource_targets_role_scope_check"
    CHECK (
      ("role" = 'user_media' AND "video_id" IS NULL)
      OR
      ("role" <> 'user_media' AND "video_id" IS NOT NULL)
    ),
  CONSTRAINT "external_resource_targets_selector_role_check"
    CHECK (
      ("role" IN ('source', 'user_media') AND "selector_kind" = 'exact')
      OR
      ("role" IN ('hls_artifacts', 'thumbnail_prefix') AND "selector_kind" = 'prefix')
    ),
  CONSTRAINT "external_resource_targets_multipart_selector_check"
    CHECK (NOT "may_have_multipart_upload" OR "selector_kind" = 'exact'),
  CONSTRAINT "external_resource_targets_goal_state_check"
    CHECK (
      (
        "goal" = 'present'
        AND "state" IN ('writing', 'reconciling', 'confirmed_present')
        AND "quiescence_not_before" IS NULL
      )
      OR
      (
        "goal" = 'absent'
        AND "state" IN ('quiescing', 'reconciling', 'confirmed_absent')
        AND "quiescence_not_before" IS NOT NULL
      )
    ),
  CONSTRAINT "external_resource_targets_lease_check"
    CHECK (
      (
        "state" = 'reconciling'
        AND "reconciliation_lease_id" IS NOT NULL
        AND "reconciliation_lease_expires_at" IS NOT NULL
      )
      OR
      (
        "state" <> 'reconciling'
        AND "reconciliation_lease_id" IS NULL
        AND "reconciliation_lease_expires_at" IS NULL
      )
    )
);

-- CreateTable
CREATE TABLE "external_multipart_handles" (
  "id" UUID NOT NULL,
  "target_id" UUID NOT NULL,
  "upload_session_id" UUID,
  "upload_id" VARCHAR(1024) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "external_multipart_handles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_multipart_handles_upload_id_check" CHECK (length("upload_id") > 0)
);

-- DomainConstraints
ALTER TABLE "user_media_assets"
  ADD CONSTRAINT "user_media_assets_dimensions_size_check"
  CHECK ("size_bytes" > 0 AND "width" > 0 AND "height" > 0 AND length("bucket") > 0);

ALTER TABLE "videos"
  ADD CONSTRAINT "videos_source_fields_check"
  CHECK (
    (
      "source_upload_session_id" IS NULL
      AND "source_object_key" IS NULL
      AND "source_size_bytes" IS NULL
    )
    OR
    (
      "source_upload_session_id" IS NOT NULL
      AND "source_object_key" IS NOT NULL
      AND "source_size_bytes" > 0
    )
  ),
  ADD CONSTRAINT "videos_active_artifact_fields_check"
  CHECK (
    (
      "active_artifact_generation_id" IS NULL
      AND "hls_master_object_key" IS NULL
      AND "thumbnail_object_key" IS NULL
    )
    OR
    (
      "active_artifact_generation_id" IS NOT NULL
      AND "hls_master_object_key" IS NOT NULL
      AND "thumbnail_object_key" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "videos_media_metadata_check"
  CHECK (
    ("duration_seconds" IS NULL OR "duration_seconds" > 0)
    AND ("width" IS NULL OR "width" > 0)
    AND ("height" IS NULL OR "height" > 0)
  );

ALTER TABLE "video_renditions"
  ADD CONSTRAINT "video_renditions_dimensions_bitrate_check"
  CHECK ("width" > 0 AND "height" > 0 AND "bitrate" > 0);

ALTER TABLE "video_transcode_jobs"
  ADD CONSTRAINT "video_transcode_jobs_attempts_check"
  CHECK ("attempts" >= 0 AND "max_attempts" > 0 AND "attempts" <= "max_attempts");

ALTER TABLE "video_upload_sessions"
  ADD CONSTRAINT "video_upload_sessions_sizes_parts_check"
  CHECK (
    "part_size_bytes" > 0
    AND "expected_size_bytes" > 0
    AND ("part_count" IS NULL OR "part_count" > 0)
  ),
  ADD CONSTRAINT "video_upload_sessions_terminal_dates_check"
  CHECK (
    ("status" = 'completed') = ("completed_at" IS NOT NULL)
    AND ("status" = 'aborted') = ("aborted_at" IS NOT NULL)
    AND ("status" = 'expired') = ("expired_at" IS NOT NULL)
  );

ALTER TABLE "video_upload_parts"
  ADD CONSTRAINT "video_upload_parts_numbers_size_check"
  CHECK ("part_number" > 0 AND ("size_bytes" IS NULL OR "size_bytes" > 0));

ALTER TABLE "video_artifact_generations"
  ADD CONSTRAINT "video_artifact_generations_nonempty_bucket_check"
  CHECK (length("bucket") > 0),
  ADD CONSTRAINT "video_artifact_generations_state_fields_check"
  CHECK (
    (
      "state" = 'writing'
      AND "activated_at" IS NULL
      AND "retired_at" IS NULL
    )
    OR
    (
      "state" IN ('active', 'retiring')
      AND "hls_master_object_key" IS NOT NULL
      AND "thumbnail_object_key" IS NOT NULL
      AND "activated_at" IS NOT NULL
      AND "retired_at" IS NULL
    )
    OR
    (
      "state" = 'retired'
      AND "hls_master_object_key" IS NOT NULL
      AND "thumbnail_object_key" IS NOT NULL
      AND "retired_at" IS NOT NULL
    )
  );

-- CreateIndex
CREATE UNIQUE INDEX "video_artifact_generations_execution_id_key"
  ON "video_artifact_generations"("execution_id");
CREATE UNIQUE INDEX "video_artifact_generations_hls_master_object_key_key"
  ON "video_artifact_generations"("hls_master_object_key");
CREATE UNIQUE INDEX "video_artifact_generations_thumbnail_object_key_key"
  ON "video_artifact_generations"("thumbnail_object_key");
CREATE INDEX "video_artifact_generations_video_id_state_idx"
  ON "video_artifact_generations"("video_id", "state");
CREATE INDEX "video_artifact_generations_state_updated_at_id_idx"
  ON "video_artifact_generations"("state", "updated_at", "id");
CREATE INDEX "video_artifact_generations_source_upload_session_id_idx"
  ON "video_artifact_generations"("source_upload_session_id");
CREATE INDEX "video_artifact_generations_transcode_job_id_idx"
  ON "video_artifact_generations"("transcode_job_id");

CREATE INDEX "external_resource_targets_role_state_next_attempt_at_id_idx"
  ON "external_resource_targets"("role", "state", "next_attempt_at", "id");
CREATE INDEX "external_resource_targets_reconciliation_lease_expires_at_idx"
  ON "external_resource_targets"("reconciliation_lease_expires_at");
CREATE INDEX "external_resource_targets_user_id_role_state_idx"
  ON "external_resource_targets"("user_id", "role", "state");
CREATE INDEX "external_resource_targets_video_id_role_state_idx"
  ON "external_resource_targets"("video_id", "role", "state");
CREATE UNIQUE INDEX "external_resource_targets_bucket_selector_kind_selector_key"
  ON "external_resource_targets"("bucket", "selector_kind", "selector");

CREATE UNIQUE INDEX "external_multipart_handles_upload_session_id_key"
  ON "external_multipart_handles"("upload_session_id");
CREATE UNIQUE INDEX "external_multipart_handles_target_id_upload_id_key"
  ON "external_multipart_handles"("target_id", "upload_id");

CREATE UNIQUE INDEX "user_media_assets_external_resource_target_id_key"
  ON "user_media_assets"("external_resource_target_id");

CREATE UNIQUE INDEX "video_renditions_artifact_generation_id_quality_key"
  ON "video_renditions"("artifact_generation_id", "quality");

CREATE UNIQUE INDEX "video_transcode_jobs_execution_id_key"
  ON "video_transcode_jobs"("execution_id");
CREATE INDEX "video_transcode_jobs_heartbeat_at_idx"
  ON "video_transcode_jobs"("heartbeat_at");

CREATE UNIQUE INDEX "video_upload_sessions_external_resource_target_id_key"
  ON "video_upload_sessions"("external_resource_target_id");
CREATE UNIQUE INDEX "video_upload_sessions_bucket_object_key_key"
  ON "video_upload_sessions"("bucket", "object_key");
CREATE UNIQUE INDEX "video_upload_sessions_one_active_per_video_key"
  ON "video_upload_sessions"("video_id")
  WHERE "status" IN ('initializing', 'initiated', 'uploading', 'completing');

CREATE UNIQUE INDEX "videos_source_upload_session_id_key"
  ON "videos"("source_upload_session_id");
CREATE UNIQUE INDEX "videos_active_artifact_generation_id_key"
  ON "videos"("active_artifact_generation_id");

-- AddForeignKey
ALTER TABLE "videos"
  ADD CONSTRAINT "videos_source_upload_session_id_fkey"
  FOREIGN KEY ("source_upload_session_id") REFERENCES "video_upload_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "videos"
  ADD CONSTRAINT "videos_active_artifact_generation_id_fkey"
  FOREIGN KEY ("active_artifact_generation_id") REFERENCES "video_artifact_generations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "video_renditions"
  ADD CONSTRAINT "video_renditions_artifact_generation_id_fkey"
  FOREIGN KEY ("artifact_generation_id") REFERENCES "video_artifact_generations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "video_artifact_generations"
  ADD CONSTRAINT "video_artifact_generations_video_id_fkey"
  FOREIGN KEY ("video_id") REFERENCES "videos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "video_artifact_generations"
  ADD CONSTRAINT "video_artifact_generations_source_upload_session_id_fkey"
  FOREIGN KEY ("source_upload_session_id") REFERENCES "video_upload_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "video_artifact_generations"
  ADD CONSTRAINT "video_artifact_generations_transcode_job_id_fkey"
  FOREIGN KEY ("transcode_job_id") REFERENCES "video_transcode_jobs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_multipart_handles"
  ADD CONSTRAINT "external_multipart_handles_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "external_resource_targets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_multipart_handles"
  ADD CONSTRAINT "external_multipart_handles_upload_session_id_fkey"
  FOREIGN KEY ("upload_session_id") REFERENCES "video_upload_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "video_upload_sessions"
  ADD CONSTRAINT "video_upload_sessions_external_resource_target_id_fkey"
  FOREIGN KEY ("external_resource_target_id") REFERENCES "external_resource_targets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_media_assets"
  ADD CONSTRAINT "user_media_assets_external_resource_target_id_fkey"
  FOREIGN KEY ("external_resource_target_id") REFERENCES "external_resource_targets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "videos_visibility_moderation_status_processing_status_created_a"
  RENAME TO "videos_visibility_moderation_status_processing_status_creat_idx";
