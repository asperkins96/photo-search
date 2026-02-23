import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.$queryRaw<Array<{ value: string; count: number }>>`
    SELECT
      p."lensModel" AS "value",
      COUNT(*)::int AS "count"
    FROM "Photo" p
    WHERE p."status" = 'READY'::"PhotoStatus"
      AND p."lensModel" IS NOT NULL
      AND p."lensModel" <> ''
    GROUP BY p."lensModel"
    ORDER BY COUNT(*) DESC, p."lensModel" ASC
  `;

  return NextResponse.json(rows);
}
