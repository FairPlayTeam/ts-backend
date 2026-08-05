-- Ready videos are published only after ffprobe duration metadata is persisted.
-- Abort instead of accepting an already-invalid catalog state if a database
-- diverged from that application invariant.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "videos"
        WHERE "processing_status" = 'ready'
          AND "duration_seconds" IS NULL
    ) THEN
        RAISE EXCEPTION
            'Cannot require ready video duration: ready videos contain null duration_seconds';
    END IF;
END;
$$;

-- AddCheckConstraint
ALTER TABLE "videos"
ADD CONSTRAINT "videos_ready_duration_required_check" CHECK (
    "processing_status" <> 'ready' OR "duration_seconds" IS NOT NULL
);
