import { NextResponse } from "next/server";
import { enqueueProcessPhoto } from "@/lib/queue";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { photoId } = body as { photoId: string };
  if (!photoId) return NextResponse.json({ error: "photoId required" }, { status: 400 });

  // Mark as "received" if you want (optional). For now just ensure it exists:
  const photo = await prisma.photo.findUnique({ where: { id: photoId }, select: { id: true } });
  if (!photo) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.photo.update({
    where: { id: photoId },
    data: { status: "QUEUED", errorMessage: null },
    select: { id: true },
  });

  await enqueueProcessPhoto(photoId);

  return NextResponse.json({ ok: true });
}
