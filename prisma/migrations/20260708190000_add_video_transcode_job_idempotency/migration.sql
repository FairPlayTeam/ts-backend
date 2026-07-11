-- Enforce one transcode job per completed source upload.
CREATE UNIQUE INDEX "video_transcode_jobs_video_id_source_object_key_key" ON "video_transcode_jobs"("video_id", "source_object_key");
