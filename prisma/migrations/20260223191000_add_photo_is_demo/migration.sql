ALTER TABLE "Photo"
  ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Photo_isDemo_createdAt_idx"
  ON "Photo" ("isDemo", "createdAt" DESC, "id" DESC);
