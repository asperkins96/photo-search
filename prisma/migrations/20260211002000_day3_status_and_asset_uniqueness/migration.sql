DO $$
BEGIN
  CREATE TYPE "PhotoStatus" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'ERROR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Photo"
  ADD COLUMN IF NOT EXISTS "status" "PhotoStatus" NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Asset_photoId_type_key" ON "Asset"("photoId", "type");
DROP INDEX IF EXISTS "Asset_photoId_type_idx";
