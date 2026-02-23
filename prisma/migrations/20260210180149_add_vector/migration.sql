CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Embedding"
ADD COLUMN IF NOT EXISTS "vector" vector(512);

CREATE INDEX IF NOT EXISTS "Embedding_vector_idx"
ON "Embedding" USING ivfflat ("vector" vector_l2_ops) WITH (lists = 100);
