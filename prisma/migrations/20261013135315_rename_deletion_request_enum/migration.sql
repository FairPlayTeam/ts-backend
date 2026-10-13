/*
  Warnings:

  - The `deletion_origin` column on the `videos` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "VideoDeletionRequestOrigin" AS ENUM ('moderator', 'admin');

-- AlterTable
ALTER TABLE "videos" DROP COLUMN "deletion_origin",
ADD COLUMN     "deletion_origin" "VideoDeletionRequestOrigin";

-- DropEnum
DROP TYPE "VideoDeletionOrigin";
