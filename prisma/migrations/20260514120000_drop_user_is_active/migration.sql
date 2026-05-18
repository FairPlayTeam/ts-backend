-- DropColumn
ALTER TABLE "users" DROP COLUMN "is_active";
DROP INDEX "sessions_session_key_idx";
