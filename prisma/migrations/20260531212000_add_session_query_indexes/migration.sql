-- DropIndex
DROP INDEX "sessions_user_id_idx";

-- DropIndex
DROP INDEX "sessions_is_active_idx";

-- CreateIndex
CREATE INDEX "sessions_user_id_is_active_expires_at_idx" ON "sessions"("user_id", "is_active", "expires_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_is_active_last_used_at_id_idx" ON "sessions"("user_id", "is_active", "last_used_at", "id");

-- CreateIndex
CREATE INDEX "sessions_is_active_updated_at_idx" ON "sessions"("is_active", "updated_at");
