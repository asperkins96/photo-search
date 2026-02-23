import { NextResponse } from "next/server";
import { photoQueue } from "@/lib/queue";

export async function GET() {
  const counts = await photoQueue.getJobCounts();
  return NextResponse.json(counts);
}
