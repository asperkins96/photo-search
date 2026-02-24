import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { r2 } from "@/lib/r2";

export async function DELETE(_: Request, context: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await context.params;
  if (!photoId) return NextResponse.json({ error: "photoId required" }, { status: 400 });

  const photo = await prisma.photo.findUnique({
    where: { id: photoId },
    select: {
      id: true,
      originalKey: true,
      assets: { select: { key: true } },
      embedding: { select: { photoId: true } },
    },
  });

  if (!photo) return NextResponse.json({ error: "photo not found" }, { status: 404 });

  const originalsBucket = process.env.R2_BUCKET_ORIGINALS;
  const derivativesBucket = process.env.R2_BUCKET_DERIVATIVES;
  if (!originalsBucket || !derivativesBucket) {
    return NextResponse.json({ error: "R2 bucket env vars missing" }, { status: 500 });
  }

  const derivativeKeys = Array.from(
    new Set(
      photo.assets.map((asset: { key: string }) => asset.key)
    )
  );

  try {
    if (photo.originalKey) {
      await r2.send(new DeleteObjectCommand({ Bucket: originalsBucket, Key: photo.originalKey }));
    }

    await Promise.all(
      derivativeKeys.map((key) => r2.send(new DeleteObjectCommand({ Bucket: derivativesBucket, Key: key })))
    );

    await prisma.$transaction(async (tx) => {
      if (photo.embedding) await tx.embedding.delete({ where: { photoId: photo.id } });
      await tx.asset.deleteMany({ where: { photoId: photo.id } });
      await tx.photo.delete({ where: { id: photo.id } });
    });

    return NextResponse.json({ ok: true, photoId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await context.params;
  if (!photoId) return NextResponse.json({ error: "photoId required" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const isDemo = (body as { isDemo?: unknown }).isDemo;
  if (typeof isDemo !== "boolean") {
    return NextResponse.json({ error: "isDemo boolean required" }, { status: 400 });
  }

  try {
    const updated = await prisma.$executeRaw`
      UPDATE "Photo" SET "isDemo" = ${isDemo} WHERE "id" = ${photoId}
    `;
    if (updated === 0) return NextResponse.json({ error: "photo not found" }, { status: 404 });

    const rows = await prisma.$queryRaw<Array<{ id: string; isDemo: boolean }>>`
      SELECT "id", "isDemo" FROM "Photo" WHERE "id" = ${photoId} LIMIT 1
    `;
    const photo = rows[0];
    if (!photo) return NextResponse.json({ error: "photo not found" }, { status: 404 });
    return NextResponse.json({ ok: true, photo });
  } catch {
    return NextResponse.json({ error: "photo not found" }, { status: 404 });
  }
}
