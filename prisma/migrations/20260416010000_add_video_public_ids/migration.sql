ALTER TABLE "videos"
ADD COLUMN "public_id" TEXT;

CREATE UNIQUE INDEX "videos_public_id_key" ON "videos"("public_id");
