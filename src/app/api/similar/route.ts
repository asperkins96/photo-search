import { NextResponse } from "next/server";
import { sqltag as sql } from "@prisma/client/runtime/client";
import { prisma } from "@/lib/prisma";
import { resolveAssetUrl, type GalleryPhoto } from "@/lib/gallery";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;

function clampLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const photoId = searchParams.get("photoId");
  const limit = clampLimit(searchParams.get("limit"));
  const demoOnly = searchParams.get("demoOnly") === "true";

  if (!photoId) return NextResponse.json({ error: "photoId is required" }, { status: 400 });

  const rows = await prisma.$queryRaw<
    Array<{
      photoId: string;
      dist: number;
      createdAt: Date;
      takenAt: Date | null;
      width: number | null;
      height: number | null;
      cameraModel: string | null;
      lensModel: string | null;
      iso: number | null;
      fNumber: number | null;
      shutter: string | null;
      focalLength: number | null;
      thumbKey: string | null;
      previewKey: string | null;
    }>
  >`
    SELECT
      p."id" AS "photoId",
      (e."vector" <-> q."vector") AS "dist",
      p."createdAt" AS "createdAt",
      p."takenAt" AS "takenAt",
      p."width" AS "width",
      p."height" AS "height",
      p."cameraModel" AS "cameraModel",
      p."lensModel" AS "lensModel",
      p."iso" AS "iso",
      p."fNumber" AS "fNumber",
      p."shutter" AS "shutter",
      p."focalLength" AS "focalLength",
      thumb."key" AS "thumbKey",
      preview."key" AS "previewKey"
    FROM "Embedding" q
    JOIN "Embedding" e ON e."photoId" <> q."photoId" AND e."vector" IS NOT NULL
    JOIN "Photo" p ON p."id" = e."photoId" AND p."status" = 'READY'::"PhotoStatus"
    LEFT JOIN "Asset" thumb ON thumb."photoId" = p."id" AND thumb."type" = 'THUMB'::"AssetType"
    LEFT JOIN "Asset" preview ON preview."photoId" = p."id" AND preview."type" = 'PREVIEW'::"AssetType"
    WHERE q."photoId" = ${photoId}
      AND q."vector" IS NOT NULL
      AND thumb."key" IS NOT NULL
      ${demoOnly ? sql`AND p."isDemo" = true` : sql``}
    ORDER BY e."vector" <-> q."vector" ASC
    LIMIT ${limit}
  `;

  const mapped = await Promise.all(
    rows.map(async (row) => {
      if (!row.thumbKey) return null;
      return {
        photoId: row.photoId,
        id: row.photoId,
        createdAt: row.createdAt.toISOString(),
        takenAt: row.takenAt?.toISOString() ?? null,
        width: row.width,
        height: row.height,
        cameraModel: row.cameraModel,
        lensModel: row.lensModel,
        iso: row.iso,
        fNumber: row.fNumber,
        shutter: row.shutter,
        focalLength: row.focalLength,
        thumbKey: row.thumbKey,
        previewKey: row.previewKey,
        thumbUrl: await resolveAssetUrl(row.thumbKey),
        previewUrl: row.previewKey ? await resolveAssetUrl(row.previewKey) : null,
        dist: row.dist,
        distance: row.dist,
      };
    })
  );
  const results = mapped.filter(Boolean) as GalleryPhoto[];

  return NextResponse.json({ photoId, results });
}
