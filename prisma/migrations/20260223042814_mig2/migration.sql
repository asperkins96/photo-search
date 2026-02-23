/*
  Warnings:

  - You are about to drop the column `vector` on the `Embedding` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Embedding_vector_idx";

-- DropIndex
DROP INDEX "Photo_tags_gin_idx";

-- AlterTable
ALTER TABLE "Embedding" DROP COLUMN "vector";
