import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const MAX_LIMIT = 50;

function clampLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function toVectorLiteral(vector: unknown) {
  if (!Array.isArray(vector)) return null;
  if (!vector.length) return null;
  if (!vector.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return `[${vector.join(",")}]`;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const photoId = searchParams.get("photoId");
  const limit = clampLimit(searchParams.get("limit"));

  if (!photoId) return NextResponse.json({ error: "photoId is required" }, { status: 400 });

  const rows = await prisma.$queryRaw<
    Array<{ photoId: string; distance: number; thumbKey: string | null; previewKey: string | null }>
  >`
    SELECT
      e2."photoId" AS "photoId",
      (e2."vector" <-> e1."vector") AS "distance",
      thumb."key" AS "thumbKey",
      preview."key" AS "previewKey"
    FROM "Embedding" e1
    JOIN "Embedding" e2 ON e1."photoId" <> e2."photoId"
    LEFT JOIN "Asset" thumb ON thumb."photoId" = e2."photoId" AND thumb."type" = 'THUMB'::"AssetType"
    LEFT JOIN "Asset" preview ON preview."photoId" = e2."photoId" AND preview."type" = 'PREVIEW'::"AssetType"
    WHERE e1."photoId" = ${photoId}
      AND e1."vector" IS NOT NULL
      AND e2."vector" IS NOT NULL
    ORDER BY e2."vector" <-> e1."vector" ASC
    LIMIT ${limit}
  `;

  return NextResponse.json({ sourcePhotoId: photoId, limit, results: rows });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const vector = (body as { vector?: unknown }).vector;
  const limit = clampLimit((body as { limit?: unknown }).limit);
  const vectorLiteral = toVectorLiteral(vector);

  if (!vectorLiteral) {
    return NextResponse.json({ error: "vector must be an array of finite numbers" }, { status: 400 });
  }

  const rows = await prisma.$queryRaw<
    Array<{ photoId: string; distance: number; thumbKey: string | null; previewKey: string | null }>
  >`
    SELECT
      e."photoId" AS "photoId",
      (e."vector" <-> ${vectorLiteral}::vector) AS "distance",
      thumb."key" AS "thumbKey",
      preview."key" AS "previewKey"
    FROM "Embedding" e
    LEFT JOIN "Asset" thumb ON thumb."photoId" = e."photoId" AND thumb."type" = 'THUMB'::"AssetType"
    LEFT JOIN "Asset" preview ON preview."photoId" = e."photoId" AND preview."type" = 'PREVIEW'::"AssetType"
    WHERE e."vector" IS NOT NULL
    ORDER BY e."vector" <-> ${vectorLiteral}::vector ASC
    LIMIT ${limit}
  `;

  return NextResponse.json({ limit, results: rows });
}
