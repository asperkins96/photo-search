import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2 } from "@/lib/r2";
import { prisma } from "@/lib/prisma";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { filename, mimeType, byteSize } = body as {
    filename: string;
    mimeType: string;
    byteSize?: number;
  };

  if (!filename || !mimeType) {
    return NextResponse.json({ error: "filename and mimeType required" }, { status: 400 });
  }
  if (!mimeType.startsWith("image/")) {
    return NextResponse.json({ error: "only image uploads are supported" }, { status: 400 });
  }
  if (typeof byteSize === "number" && byteSize > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `file exceeds ${MAX_UPLOAD_BYTES} bytes limit` }, { status: 413 });
  }

  const originalsBucket = process.env.R2_BUCKET_ORIGINALS!;
  const key = `originals/${crypto.randomUUID()}-${safeFilename(filename)}`;

  // Create DB row now (so the UI has an id immediately)
  const photo = await prisma.photo.create({
    data: {
      originalKey: key,
      mimeType,
      byteSize: byteSize ?? null,
      status: "QUEUED",
      errorMessage: null,
    },
    select: { id: true, originalKey: true },
  });

  const cmd = new PutObjectCommand({
    Bucket: originalsBucket,
    Key: key,
    ContentType: mimeType,
    ContentLength: typeof byteSize === "number" ? byteSize : undefined,
  });

  const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn: 60 * 10 });

  return NextResponse.json({
    photoId: photo.id,
    key,
    uploadUrl,
  });
}
