-- AddCheckConstraint
ALTER TABLE "comments"
ADD CONSTRAINT "comments_deleted_like_count_zero_check"
CHECK ("deleted_at" IS NULL OR "like_count" = 0);
