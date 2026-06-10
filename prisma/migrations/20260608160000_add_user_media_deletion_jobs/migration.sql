CREATE TABLE "user_media_deletion_jobs" (
    "id" TEXT NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_media_deletion_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_media_deletion_jobs_object_key_key" ON "user_media_deletion_jobs"("object_key");

CREATE INDEX "user_media_deletion_jobs_next_attempt_at_id_idx" ON "user_media_deletion_jobs"("next_attempt_at", "id");
