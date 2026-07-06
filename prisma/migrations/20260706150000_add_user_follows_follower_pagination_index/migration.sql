-- CreateIndex
CREATE INDEX "user_follows_follower_id_created_at_following_id_idx" ON "user_follows"("follower_id", "created_at", "following_id");
