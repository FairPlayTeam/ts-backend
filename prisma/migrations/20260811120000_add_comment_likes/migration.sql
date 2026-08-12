-- AlterTable
ALTER TABLE "comments"
ADD COLUMN "like_count" INTEGER NOT NULL DEFAULT 0;

-- AddCheckConstraint
ALTER TABLE "comments"
ADD CONSTRAINT "comments_like_count_nonnegative_check" CHECK ("like_count" >= 0);

-- CreateTable
CREATE TABLE "comment_likes" (
    "user_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_likes_pkey" PRIMARY KEY ("user_id", "comment_id")
);

-- CreateIndex
CREATE INDEX "comment_likes_comment_id_idx" ON "comment_likes"("comment_id");

-- AddForeignKey
ALTER TABLE "comment_likes"
ADD CONSTRAINT "comment_likes_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes"
ADD CONSTRAINT "comment_likes_comment_id_fkey"
FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
