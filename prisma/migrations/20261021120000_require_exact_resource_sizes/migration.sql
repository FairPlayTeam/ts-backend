-- A CHECK accepts NULL results: positive sizes also need an explicit presence guard.
ALTER TABLE "external_resource_targets"
  DROP CONSTRAINT "external_resource_targets_expected_size_check",
  ADD CONSTRAINT "external_resource_targets_expected_size_check"
    CHECK (
      (
        "role" IN ('source', 'source_thumbnail', 'user_media')
        AND "expected_size_bytes" IS NOT NULL
        AND "expected_size_bytes" > 0
      )
      OR
      (
        "role" NOT IN ('source', 'source_thumbnail', 'user_media')
        AND "expected_size_bytes" IS NULL
      )
    );

ALTER TABLE "videos"
  DROP CONSTRAINT "videos_source_fields_check",
  ADD CONSTRAINT "videos_source_fields_check"
    CHECK (
      (
        "source_upload_session_id" IS NULL
        AND "source_object_key" IS NULL
        AND "source_size_bytes" IS NULL
      )
      OR
      (
        "source_upload_session_id" IS NOT NULL
        AND "source_object_key" IS NOT NULL
        AND "source_size_bytes" IS NOT NULL
        AND "source_size_bytes" > 0
      )
    );
