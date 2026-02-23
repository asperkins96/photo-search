import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.$queryRaw<Array<{ value: string; count: number }>>`
    SELECT
      p."cameraModel" AS "value",
      COUNT(*)::int AS "count"
    FROM "Photo" p
    WHERE p."status" = 'READY'::"PhotoStatus"
      AND p."cameraModel" IS NOT NULL
      AND p."cameraModel" <> ''
    GROUP BY p."cameraModel"
    ORDER BY COUNT(*) DESC, p."cameraModel" ASC
  `;

  return NextResponse.json(rows);
}
