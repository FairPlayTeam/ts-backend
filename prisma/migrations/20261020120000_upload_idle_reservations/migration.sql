-- Existing sources get up to fifteen minutes of grace, bounded by their original expiry.
-- Completing sources retain their reservation and reconciliation protocol without an age cutoff.
ALTER TABLE "video_upload_sessions"
  ADD COLUMN "hard_expires_at" TIMESTAMP(3),
  ADD COLUMN "verified_uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "next_progress_check_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "video_upload_sessions"
SET "hard_expires_at" = "expires_at";

UPDATE "video_upload_sessions"
SET "expires_at" = LEAST("expires_at", CURRENT_TIMESTAMP + INTERVAL '15 minutes')
WHERE "status" IN ('initializing', 'initiated', 'uploading');

ALTER TABLE "video_upload_sessions"
  ALTER COLUMN "hard_expires_at" SET NOT NULL,
  ADD CONSTRAINT "video_upload_sessions_reservation_progress_check"
    CHECK (
      "expires_at" <= "hard_expires_at"
      AND "verified_uploaded_bytes" >= 0
      AND "verified_uploaded_bytes" <= "expected_size_bytes"
    );
