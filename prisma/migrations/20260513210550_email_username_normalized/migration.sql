/*
  Warnings:

  - You are about to alter the column `email` on the `users` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(254)`.
  - You are about to alter the column `username` on the `users` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(20)`.

*/
-- AlterTable
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE VARCHAR(254),
ALTER COLUMN "username" SET DATA TYPE VARCHAR(20);

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_check"
  CHECK ("email" = lower(trim("email")));

ALTER TABLE "users"
  ADD CONSTRAINT "users_username_normalized_check"
  CHECK (
    "username" = lower(trim("username"))
    AND "username" ~ '^[a-z0-9_]+$'
  );