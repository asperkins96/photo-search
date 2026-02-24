import { AssetType } from "@prisma/client";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "@/lib/prisma";
import { r2 } from "@/lib/r2";

const PAGE_SIZE = 60;

export type PhotoCursor = {
  createdAt: string;
  id: string;
};

export type GalleryPhoto = {
  photoId?: string;
  id: string;
  createdAt: string;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  cameraModel: string | null;
  lensModel: string | null;
  iso: number | null;
  fNumber: number | null;
  shutter: string | null;
  focalLength?: number | null;
  thumbUrl: string;
  previewUrl: string | null;
  thumbKey?: string | null;
  previewKey?: string | null;
  dist?: number;
  distance?: number;
  isDemo?: boolean;
};

type PhotoRow = {
  id: string;
  createdAt: Date;
  takenAt: Date | null;
  width: number | null;
  height: number | null;
  cameraModel: string | null;
  lensModel: string | null;
  iso: number | null;
  fNumber: number | null;
  shutter: string | null;
  isDemo: boolean;
  assets: Array<{ type: AssetType; key: string }>;
};

function getPublicDerivativesBaseUrl() {
  const base = process.env.R2_PUBLIC_DERIVATIVES_BASE_URL ?? process.env.R2_PUBLIC_BASE_URL ?? "";
  const normalized = base.replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized.includes("<") || normalized.includes(">")) return "";
  if (normalized.includes("your-public-r2-domain")) return "";
  return normalized;
}

export async function resolveAssetUrl(key: string) {
  const publicBase = getPublicDerivativesBaseUrl();
  if (publicBase) return `${publicBase}/${key}`;

  const bucket = process.env.R2_BUCKET_DERIVATIVES!;
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 * 30 });
}

function parseCursor(cursor?: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as PhotoCursor;
    if (!decoded?.createdAt || !decoded?.id) return null;
    return { createdAt: new Date(decoded.createdAt), id: decoded.id };
  } catch {
    return null;
  }
}

function buildCursor(row: PhotoRow) {
  const payload: PhotoCursor = { createdAt: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export async function getGalleryPage(cursor?: string | null, options?: { demoOnly?: boolean }) {
  const parsedCursor = parseCursor(cursor);
  const demoOnly = options?.demoOnly ?? false;

  const rows = (await prisma.photo.findMany({
    where: {
      status: "READY",
      assets: { some: { type: "THUMB" } },
      ...(demoOnly ? { isDemo: true } : {}),
      ...(parsedCursor
        ? {
            OR: [{ createdAt: { lt: parsedCursor.createdAt } }, { createdAt: parsedCursor.createdAt, id: { lt: parsedCursor.id } }],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    select: {
      id: true,
      createdAt: true,
      takenAt: true,
      width: true,
      height: true,
      cameraModel: true,
      lensModel: true,
      iso: true,
      fNumber: true,
      shutter: true,
      isDemo: true,
      assets: {
        where: { type: { in: ["THUMB", "PREVIEW"] } },
        select: { type: true, key: true },
      },
    },
  })) as unknown as PhotoRow[];

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  const photos = await Promise.all(
    pageRows.map(async (row) => {
      const thumb = row.assets.find((a) => a.type === "THUMB");
      if (!thumb) return null;
      const preview = row.assets.find((a) => a.type === "PREVIEW");

      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        takenAt: row.takenAt?.toISOString() ?? null,
        width: row.width,
        height: row.height,
        cameraModel: row.cameraModel,
        lensModel: row.lensModel,
        iso: row.iso,
        fNumber: row.fNumber,
        shutter: row.shutter,
        isDemo: row.isDemo,
        focalLength: null,
        thumbUrl: await resolveAssetUrl(thumb.key),
        previewUrl: preview ? await resolveAssetUrl(preview.key) : null,
      } satisfies GalleryPhoto;
    })
  );

  const normalized = photos.filter(Boolean) as GalleryPhoto[];
  const nextCursor = hasMore ? buildCursor(pageRows[PAGE_SIZE - 1]!) : null;

  return { photos: normalized, nextCursor };
}
