import "dotenv/config";
import IORedis from "ioredis";
import { Worker } from "bullmq";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "../src/lib/r2";
import { prisma } from "../src/lib/prisma";
import sharp from "sharp";
import exifr from "exifr";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

type S3BodyWithBytes = {
  transformToByteArray: () => Promise<Uint8Array>;
};

const EMBEDDING_DIMENSIONS = 512;
const EMBEDDING_MODEL = "openclip:ViT-B-32/laion2b_s34b_b79k";

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  if (!stream || typeof stream !== "object" || !("transformToByteArray" in stream)) {
    throw new Error("Unexpected S3 object body shape");
  }
  const body = stream as S3BodyWithBytes;
  return Buffer.from(await body.transformToByteArray());
}

async function runPythonEmbedder(imagePath: string) {
  const pythonBin = process.env.EMBED_PYTHON_BIN ?? "python3";

  return new Promise<number[]>((resolve, reject) => {
    const proc = spawn(pythonBin, ["embedder/embed.py", imagePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => reject(error));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`embedder failed (code ${code}): ${stderr.trim() || "no stderr output"}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (!Array.isArray(parsed)) throw new Error("embedder output is not an array");
        if (parsed.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`expected ${EMBEDDING_DIMENSIONS} dimensions, got ${parsed.length}`);
        }
        if (!parsed.every((value) => typeof value === "number" && Number.isFinite(value))) {
          throw new Error("embedding contains non-finite values");
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`invalid embedder output: ${error instanceof Error ? error.message : "parse error"}`));
      }
    });
  });
}

async function runPythonCaptioner(imagePath: string) {
  const pythonBin = process.env.EMBED_PYTHON_BIN ?? "python3";

  return new Promise<{ caption: string | null; tags: string[] }>((resolve, reject) => {
    const proc = spawn(pythonBin, ["embedder/caption.py", imagePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => reject(error));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`captioner failed (code ${code}): ${stderr.trim() || "no stderr output"}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (!parsed || typeof parsed !== "object") {
          throw new Error("captioner output is not an object");
        }
        const captionRaw = (parsed as { caption?: unknown }).caption;
        const tagsRaw = (parsed as { tags?: unknown }).tags;
        const caption = typeof captionRaw === "string" && captionRaw.trim().length > 0 ? captionRaw.trim() : null;
        const tags =
          Array.isArray(tagsRaw) && tagsRaw.every((value) => typeof value === "string")
            ? tagsRaw
                .map((value) => value.trim().toLowerCase())
                .filter((value) => value.length > 0)
                .slice(0, 24)
            : [];
        resolve({ caption, tags });
      } catch (error) {
        reject(new Error(`invalid captioner output: ${error instanceof Error ? error.message : "parse error"}`));
      }
    });
  });
}

async function embedPreview(previewBuffer: Buffer) {
  const tempDir = await mkdtemp(join(tmpdir(), "photo-embed-"));
  const tempPath = join(tempDir, "preview.jpg");

  try {
    await writeFile(tempPath, previewBuffer);
    return await runPythonEmbedder(tempPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function captionPreview(previewBuffer: Buffer) {
  const tempDir = await mkdtemp(join(tmpdir(), "photo-caption-"));
  const tempPath = join(tempDir, "preview.jpg");

  try {
    await writeFile(tempPath, previewBuffer);
    return await runPythonCaptioner(tempPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function upsertEmbedding(photoId: string, vector: number[]) {
  const vectorLiteral = `[${vector.join(",")}]`;
  await prisma.$executeRaw`
    INSERT INTO "Embedding" ("photoId", "model", "vector")
    VALUES (${photoId}, ${EMBEDDING_MODEL}, ${vectorLiteral}::vector)
    ON CONFLICT ("photoId")
    DO UPDATE SET
      "model" = EXCLUDED."model",
      "vector" = EXCLUDED."vector"
  `;
}

new Worker(
  "photo",
  async (job) => {
    const { photoId } = job.data as { photoId: string };
    const existingPhoto = await prisma.photo.findUnique({ where: { id: photoId }, select: { id: true } });
    if (!existingPhoto) return;

    await prisma.photo.update({
      where: { id: photoId },
      data: { status: "PROCESSING", errorMessage: null },
    });

    try {
      const photo = await prisma.photo.findUnique({ where: { id: photoId } });
      if (!photo) return;

      // 1) Download original from R2
      const originalsBucket = process.env.R2_BUCKET_ORIGINALS!;
      const derivativesBucket = process.env.R2_BUCKET_DERIVATIVES!;

      const obj = await r2.send(new GetObjectCommand({ Bucket: originalsBucket, Key: photo.originalKey }));
      const originalBuf = await streamToBuffer(obj.Body);

      // 2) EXIF
      const exif = (await exifr.parse(originalBuf, { gps: true }).catch(() => null)) as Record<string, unknown> | null;

      // 3) Derivatives
      const image = sharp(originalBuf);
      const meta = await image.metadata();

      const thumbBuf = await image
        .clone()
        .resize({ width: 512, height: 512, fit: "inside" })
        .jpeg({ quality: 82 })
        .toBuffer();
      const thumbMeta = await sharp(thumbBuf).metadata();

      const previewBuf = await image
        .clone()
        .resize({ width: 2048, height: 2048, fit: "inside" })
        .jpeg({ quality: 85 })
        .toBuffer();
      const previewMeta = await sharp(previewBuf).metadata();

      const thumbKey = `thumbs/${photoId}.jpg`;
      const previewKey = `previews/${photoId}.jpg`;

      await r2.send(new PutObjectCommand({ Bucket: derivativesBucket, Key: thumbKey, Body: thumbBuf, ContentType: "image/jpeg" }));
      await r2.send(new PutObjectCommand({ Bucket: derivativesBucket, Key: previewKey, Body: previewBuf, ContentType: "image/jpeg" }));

      // 4) Embedding from preview
      const vector = await embedPreview(previewBuf);
      await upsertEmbedding(photoId, vector);
      let caption: string | null = null;
      let tags: string[] = [];
      try {
        const captionResult = await captionPreview(previewBuf);
        caption = captionResult.caption;
        tags = captionResult.tags;
      } catch (captionError) {
        console.warn(`caption generation failed for ${photoId}:`, captionError);
      }

      // 5) Save metadata and derivatives
      await prisma.photo.update({
        where: { id: photoId },
        data: {
          width: meta.width ?? null,
          height: meta.height ?? null,
          takenAt: (exif?.DateTimeOriginal as Date | undefined) ?? (exif?.CreateDate as Date | undefined) ?? null,
          cameraMake: (exif?.Make as string | undefined) ?? null,
          cameraModel: (exif?.Model as string | undefined) ?? null,
          lensModel: (exif?.LensModel as string | undefined) ?? null,
          iso: (exif?.ISO as number | undefined) ?? null,
          fNumber: (exif?.FNumber as number | undefined) ?? null,
          shutter: exif?.ExposureTime ? String(exif.ExposureTime) : null,
          focalLength: (exif?.FocalLength as number | undefined) ?? null,
          gpsLat: (exif?.latitude as number | undefined) ?? null,
          gpsLon: (exif?.longitude as number | undefined) ?? null,
          status: "READY",
          errorMessage: null,
        },
      });

      await prisma.$executeRaw`
        UPDATE "Photo"
        SET "caption" = ${caption}, "tags" = ${tags}::text[]
        WHERE "id" = ${photoId}
      `;

      await prisma.asset.upsert({
        where: { photoId_type: { photoId, type: "THUMB" } },
        update: { key: thumbKey, width: thumbMeta.width ?? null, height: thumbMeta.height ?? null },
        create: { photoId, type: "THUMB", key: thumbKey, width: thumbMeta.width ?? null, height: thumbMeta.height ?? null },
      });
      await prisma.asset.upsert({
        where: { photoId_type: { photoId, type: "PREVIEW" } },
        update: { key: previewKey, width: previewMeta.width ?? null, height: previewMeta.height ?? null },
        create: {
          photoId,
          type: "PREVIEW",
          key: previewKey,
          width: previewMeta.width ?? null,
          height: previewMeta.height ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown processing error";
      await prisma.photo.update({
        where: { id: photoId },
        data: { status: "ERROR", errorMessage: message.slice(0, 2000) },
      });
      throw error;
    }
  },
  { connection }
);

console.log("Worker running…");
