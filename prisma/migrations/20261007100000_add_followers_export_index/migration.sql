-- Supports bounded cursor pagination when exporting a user's followers.
CREATE INDEX "user_follows_following_id_created_at_follower_id_idx"
ON "user_follows"("following_id", "created_at", "follower_id");

DROP INDEX "user_follows_following_id_idx";
