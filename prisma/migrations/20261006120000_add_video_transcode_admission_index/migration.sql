-- CreateIndex
CREATE INDEX "video_upload_sessions_status_expires_at_idx" ON "video_upload_sessions"("status", "expires_at");
