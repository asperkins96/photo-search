import { NextResponse } from "next/server";
import { getGalleryPage } from "@/lib/gallery";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor");
  const demoOnly = searchParams.get("demoOnly") === "true";

  const page = await getGalleryPage(cursor, { demoOnly });
  return NextResponse.json(page);
}
