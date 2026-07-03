-- AlterTable
ALTER TABLE "sessions"
  ALTER COLUMN "ip_address" TYPE VARCHAR(45) USING LEFT("ip_address", 45),
  ALTER COLUMN "user_agent" TYPE VARCHAR(512) USING LEFT("user_agent", 512),
  ALTER COLUMN "device_info" TYPE VARCHAR(512) USING LEFT("device_info", 512);
