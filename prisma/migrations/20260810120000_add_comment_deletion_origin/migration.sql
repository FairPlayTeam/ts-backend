-- CreateEnum
CREATE TYPE "CommentDeletionOrigin" AS ENUM (
    'author',
    'video_owner',
    'moderator',
    'admin',
    'account_deletion',
    'legacy_unknown'
);

-- AddColumn
ALTER TABLE "comments"
ADD COLUMN "deletion_origin" "CommentDeletionOrigin";

-- Existing tombstones cannot be classified reliably: account deletion and the
-- author route both predate this metadata. Preserve that uncertainty explicitly
-- so every deleted row can still satisfy the bidirectional lifecycle invariant.
UPDATE "comments"
SET "deletion_origin" = 'legacy_unknown'
WHERE "deleted_at" IS NOT NULL
  AND "deletion_origin" IS NULL;

ALTER TABLE "comments"
ADD CONSTRAINT "comments_deletion_origin_state_check" CHECK (
    (
        "deleted_at" IS NULL
        AND "deletion_origin" IS NULL
    )
    OR
    (
        "deleted_at" IS NOT NULL
        AND "deletion_origin" IS NOT NULL
    )
);
