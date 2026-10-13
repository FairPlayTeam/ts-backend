ALTER TABLE "sessions" ADD COLUMN "public_id" TEXT;

UPDATE "sessions"
SET "public_id" = 's_' || md5("id"::text || ':' || clock_timestamp()::text || ':' || random()::text);

ALTER TABLE "sessions" ALTER COLUMN "public_id" SET NOT NULL;

CREATE UNIQUE INDEX "sessions_public_id_key" ON "sessions"("public_id");

DROP INDEX "sessions_user_id_is_active_last_used_at_id_idx";
CREATE INDEX "sessions_user_id_is_active_last_used_at_public_id_idx"
  ON "sessions"("user_id", "is_active", "last_used_at", "public_id");
