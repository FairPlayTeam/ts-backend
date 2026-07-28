CREATE TYPE "VideoLicense" AS ENUM (
  'all_rights_reserved',
  'cc_by',
  'cc_by_sa',
  'cc_by_nd',
  'cc_by_nc',
  'cc_by_nc_sa',
  'cc_by_nc_nd',
  'cc0'
);

ALTER TABLE "videos"
  ALTER COLUMN "license" DROP DEFAULT,
  ALTER COLUMN "license" TYPE "VideoLicense" USING ("license"::"VideoLicense"),
  ALTER COLUMN "license" SET DEFAULT 'all_rights_reserved';
