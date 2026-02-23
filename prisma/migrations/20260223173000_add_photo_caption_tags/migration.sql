ALTER TABLE "Photo"
  ADD COLUMN "caption" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS "Photo_tags_gin_idx" ON "Photo" USING GIN ("tags");
