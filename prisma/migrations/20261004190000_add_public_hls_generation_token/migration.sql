-- Pre-production invariant: this table is empty, so no legacy artifact token or object-key
-- backfill is required. Applying this migration to a populated database must fail rather than
-- manufacture tokens that do not match already stored object keys.
ALTER TABLE "video_artifact_generations"
ADD COLUMN "public_token" VARCHAR(64) NOT NULL;

ALTER TABLE "video_artifact_generations"
ADD CONSTRAINT "video_artifact_generations_public_token_format_check"
CHECK ("public_token" ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX "video_artifact_generations_public_token_key"
ON "video_artifact_generations"("public_token");
