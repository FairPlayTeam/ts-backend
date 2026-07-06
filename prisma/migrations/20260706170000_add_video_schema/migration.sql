-- CreateEnum
CREATE TYPE "VideoVisibility" AS ENUM ('public', 'unlisted');

-- CreateEnum
CREATE TYPE "VideoModerationStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "VideoProcessingStatus" AS ENUM ('draft', 'uploading', 'queued', 'processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "VideoUploadSessionStatus" AS ENUM ('initiated', 'uploading', 'completed', 'aborted', 'expired');

-- CreateEnum
CREATE TYPE "VideoTranscodeJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "VideoRenditionQuality" AS ENUM ('240p', '480p', '720p', '1080p');

-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "public_id" VARCHAR(64) NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(5000),
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "license" VARCHAR(64) NOT NULL DEFAULT 'all_rights_reserved',
    "visibility" "VideoVisibility" NOT NULL DEFAULT 'unlisted',
    "allow_comments" BOOLEAN NOT NULL DEFAULT true,
    "processing_status" "VideoProcessingStatus" NOT NULL DEFAULT 'draft',
    "moderation_status" "VideoModerationStatus" NOT NULL DEFAULT 'pending',
    "source_object_key" VARCHAR(512),
    "hls_master_object_key" VARCHAR(512),
    "thumbnail_object_key" VARCHAR(512),
    "duration_seconds" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "rating_average" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "transcode_error" VARCHAR(1000),
    "legacy_storage_path" VARCHAR(512),
    "legacy_qualities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_renditions" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "quality" "VideoRenditionQuality" NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bitrate" INTEGER NOT NULL,
    "playlist_object_key" VARCHAR(512) NOT NULL,
    "segment_prefix" VARCHAR(512) NOT NULL,
    "codec" VARCHAR(50) NOT NULL,
    "container" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_renditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_transcode_jobs" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "status" "VideoTranscodeJobStatus" NOT NULL DEFAULT 'queued',
    "source_object_key" VARCHAR(512) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_error" VARCHAR(1000),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leased_by" VARCHAR(128),
    "lease_expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_transcode_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_upload_sessions" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "VideoUploadSessionStatus" NOT NULL DEFAULT 'initiated',
    "bucket" VARCHAR(128) NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "upload_id" VARCHAR(1024) NOT NULL,
    "part_size_bytes" INTEGER NOT NULL,
    "part_count" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "aborted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_upload_parts" (
    "id" UUID NOT NULL,
    "upload_session_id" UUID NOT NULL,
    "part_number" INTEGER NOT NULL,
    "etag" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_upload_parts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "videos_public_id_key" ON "videos"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "videos_source_object_key_key" ON "videos"("source_object_key");

-- CreateIndex
CREATE UNIQUE INDEX "videos_hls_master_object_key_key" ON "videos"("hls_master_object_key");

-- CreateIndex
CREATE UNIQUE INDEX "videos_thumbnail_object_key_key" ON "videos"("thumbnail_object_key");

-- CreateIndex
CREATE INDEX "videos_owner_id_created_at_id_idx" ON "videos"("owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "videos_visibility_moderation_status_processing_status_created_at_id_idx" ON "videos"("visibility", "moderation_status", "processing_status", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "video_renditions_playlist_object_key_key" ON "video_renditions"("playlist_object_key");

-- CreateIndex
CREATE UNIQUE INDEX "video_renditions_video_id_quality_key" ON "video_renditions"("video_id", "quality");

-- CreateIndex
CREATE INDEX "video_transcode_jobs_status_next_attempt_at_id_idx" ON "video_transcode_jobs"("status", "next_attempt_at", "id");

-- CreateIndex
CREATE INDEX "video_transcode_jobs_video_id_status_idx" ON "video_transcode_jobs"("video_id", "status");

-- CreateIndex
CREATE INDEX "video_transcode_jobs_lease_expires_at_idx" ON "video_transcode_jobs"("lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "video_upload_sessions_bucket_object_key_upload_id_key" ON "video_upload_sessions"("bucket", "object_key", "upload_id");

-- CreateIndex
CREATE INDEX "video_upload_sessions_video_id_status_idx" ON "video_upload_sessions"("video_id", "status");

-- CreateIndex
CREATE INDEX "video_upload_sessions_user_id_created_at_id_idx" ON "video_upload_sessions"("user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "video_upload_sessions_expires_at_idx" ON "video_upload_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "video_upload_parts_upload_session_id_part_number_key" ON "video_upload_parts"("upload_session_id", "part_number");

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renditions" ADD CONSTRAINT "video_renditions_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_transcode_jobs" ADD CONSTRAINT "video_transcode_jobs_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_upload_sessions" ADD CONSTRAINT "video_upload_sessions_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_upload_sessions" ADD CONSTRAINT "video_upload_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_upload_parts" ADD CONSTRAINT "video_upload_parts_upload_session_id_fkey" FOREIGN KEY ("upload_session_id") REFERENCES "video_upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
