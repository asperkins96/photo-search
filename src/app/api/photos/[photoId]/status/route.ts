import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_: Request, context: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await context.params;
  if (!photoId) {
    return NextResponse.json({ error: "photoId required" }, { status: 400 });
  }

  const photo = await prisma.photo.findUnique({
    where: { id: photoId },
    select: {
      id: true,
      status: true,
      errorMessage: true,
      originalKey: true,
      width: true,
      height: true,
      takenAt: true,
      updatedAt: true,
      createdAt: true,
      assets: {
        orderBy: { type: "asc" },
        select: { type: true, key: true, width: true, height: true, createdAt: true },
      },
    },
  });

  if (!photo) {
    return NextResponse.json({ error: "photo not found" }, { status: 404 });
  }

  return NextResponse.json(photo);
}
