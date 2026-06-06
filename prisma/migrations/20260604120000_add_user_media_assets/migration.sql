-- CreateEnum
CREATE TYPE "UserMediaKind" AS ENUM ('avatar', 'banner');

-- CreateTable
CREATE TABLE "user_media_assets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "UserMediaKind" NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_media_assets_object_key_key" ON "user_media_assets"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "user_media_assets_user_id_kind_key" ON "user_media_assets"("user_id", "kind");

-- AddForeignKey
ALTER TABLE "user_media_assets" ADD CONSTRAINT "user_media_assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
