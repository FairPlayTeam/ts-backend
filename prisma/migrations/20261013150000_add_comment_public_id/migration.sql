ALTER TABLE "comments" ADD COLUMN "public_id" VARCHAR(35);

UPDATE "comments"
SET "public_id" = 'c_' || REPLACE(gen_random_uuid()::text, '-', '');

ALTER TABLE "comments" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "comments" ALTER COLUMN "public_id"
  SET DEFAULT 'c_' || replace(gen_random_uuid()::text, '-', '');

CREATE UNIQUE INDEX "comments_public_id_key" ON "comments"("public_id");
