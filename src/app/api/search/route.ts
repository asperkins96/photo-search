import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveAssetUrl, type GalleryPhoto } from "@/lib/gallery";

const EMBEDDING_DIMENSIONS = 512;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;
const DEFAULT_MAX_DISTANCE = (() => {
  const parsed = Number(process.env.SEARCH_MAX_DISTANCE ?? "0.58");
  if (!Number.isFinite(parsed)) return 0.58;
  return Math.min(Math.max(parsed, 0.15), 1.2);
})();
const DEFAULT_SEMANTIC_ONLY_MAX_DISTANCE = (() => {
  const parsed = Number(process.env.SEARCH_SEMANTIC_ONLY_MAX_DISTANCE ?? "0.36");
  if (!Number.isFinite(parsed)) return 0.36;
  return Math.min(Math.max(parsed, 0.2), 0.8);
})();
const DEFAULT_SEMANTIC_ONLY_MIN_SEPARATION = (() => {
  const parsed = Number(process.env.SEARCH_SEMANTIC_ONLY_MIN_SEPARATION ?? "0.012");
  if (!Number.isFinite(parsed)) return 0.012;
  return Math.min(Math.max(parsed, 0.001), 0.08);
})();

type PendingRequest = {
  resolve: (vector: number[]) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type EmbedderState = {
  proc: ChildProcessWithoutNullStreams;
  pending: Map<number, PendingRequest>;
  nextId: number;
};

const globalForSearch = globalThis as unknown as {
  textEmbedder?: EmbedderState;
  embeddingCache?: Map<string, { vector: number[]; expiresAt: number }>;
  textEmbedderPrewarmed?: boolean;
};

function getEmbeddingCache() {
  if (!globalForSearch.embeddingCache) globalForSearch.embeddingCache = new Map();
  return globalForSearch.embeddingCache;
}

function clampLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function clampMaxDistance(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_DISTANCE;
  if (parsed <= 0) return DEFAULT_MAX_DISTANCE;
  return Math.min(Math.max(parsed, 0.15), 1.2);
}

function isLowSignalQuery(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 2) return true;

  const alphaOnly = normalized.replace(/[^a-z]/g, "");
  if (!alphaOnly.length) return true;

  const uniqueChars = new Set(alphaOnly).size;
  if (uniqueChars <= 1) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && tokens[0]!.length <= 2) return true;

  return false;
}

function buildQueryPromptEnsemble(query: string) {
  const q = query.trim();
  const variants = new Set<string>([q]);
  const tokens = q.split(/\s+/).filter(Boolean);

  if (tokens.length === 1) {
    const token = tokens[0]!.toLowerCase();
    if (token.length > 2 && token.endsWith("s")) {
      variants.add(token.slice(0, -1));
    } else if (token.length > 2) {
      variants.add(`${token}s`);
    }
  }

  const prompts: string[] = [];
  for (const variant of variants) {
    prompts.push(variant);
    prompts.push(`a photo of ${variant}`);
    prompts.push(`a picture of ${variant}`);
    prompts.push(`an image showing ${variant}`);
    prompts.push(`${variant} scene`);
  }

  return [...new Set(prompts)].slice(0, 8);
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseHasGps(value: string | null) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function validateVector(parsed: unknown) {
  if (!Array.isArray(parsed)) throw new Error("embedder output is not an array");
  if (parsed.length !== EMBEDDING_DIMENSIONS) throw new Error(`expected ${EMBEDDING_DIMENSIONS} dimensions, got ${parsed.length}`);
  if (!parsed.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("embedding contains non-finite values");
  }
  return parsed;
}

function getTextEmbedder() {
  if (globalForSearch.textEmbedder) return globalForSearch.textEmbedder;

  const pythonBin = process.env.EMBED_PYTHON_BIN ?? "python3";
  const proc = spawn(pythonBin, ["-u", "embedder/embed_text_server.py"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, PendingRequest>();
  const rl = createInterface({ input: proc.stdout });

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as { id?: number; vector?: unknown; error?: string };
      if (typeof msg.id !== "number") return;
      const req = pending.get(msg.id);
      if (!req) return;
      clearTimeout(req.timeout);
      pending.delete(msg.id);
      if (msg.error) {
        req.reject(new Error(msg.error));
        return;
      }
      req.resolve(validateVector(msg.vector));
    } catch (error) {
      // Ignore malformed lines but keep process alive for future requests.
      console.error("embed_text_server parse error", error);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) console.error("embed_text_server:", message);
  });

  proc.on("exit", (code, signal) => {
    const err = new Error(`embed_text_server exited (code=${code}, signal=${signal})`);
    for (const req of pending.values()) {
      clearTimeout(req.timeout);
      req.reject(err);
    }
    pending.clear();
    globalForSearch.textEmbedder = undefined;
  });

  const state: EmbedderState = { proc, pending, nextId: 1 };
  globalForSearch.textEmbedder = state;
  return state;
}

async function embedTextQuery(query: string) {
  const cache = getEmbeddingCache();
  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.vector;

  const embedder = getTextEmbedder();

  const vector = await new Promise<number[]>((resolve, reject) => {
    const id = embedder.nextId++;
    const timeout = setTimeout(() => {
      embedder.pending.delete(id);
      reject(new Error("text embedder timed out"));
    }, 20000);

    embedder.pending.set(id, { resolve, reject, timeout });
    embedder.proc.stdin.write(`${JSON.stringify({ id, q: query })}\n`);
  });

  cache.set(cacheKey, { vector, expiresAt: Date.now() + 1000 * 60 * 10 });
  return vector;
}

function prewarmTextEmbedder() {
  if (globalForSearch.textEmbedderPrewarmed) return;
  globalForSearch.textEmbedderPrewarmed = true;
  void embedTextQuery("photo").catch((error) => {
    console.error("search embedder prewarm failed", error);
  });
}

type SearchRow = {
  photoId: string;
  dist: number | null;
  textScore?: number | null;
  createdAt: Date;
  takenAt: Date | null;
  width: number | null;
  height: number | null;
  cameraModel: string | null;
  lensModel: string | null;
  iso: number | null;
  fNumber: number | null;
  shutter: string | null;
  focalLength: number | null;
  thumbKey: string | null;
  previewKey: string | null;
};

function tokenizeQuery(query: string) {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2))];
}

async function mapRowsToPhotos(rows: SearchRow[]) {
  const photos = await Promise.all(
    rows.map(async (row): Promise<GalleryPhoto | null> => {
      if (!row.thumbKey) return null;
      return {
        id: row.photoId,
        createdAt: row.createdAt.toISOString(),
        takenAt: row.takenAt?.toISOString() ?? null,
        width: row.width,
        height: row.height,
        cameraModel: row.cameraModel,
        lensModel: row.lensModel,
        iso: row.iso,
        fNumber: row.fNumber,
        shutter: row.shutter,
        focalLength: row.focalLength ?? null,
        thumbUrl: await resolveAssetUrl(row.thumbKey),
        previewUrl: row.previewKey ? await resolveAssetUrl(row.previewKey) : null,
        distance: row.dist ?? undefined,
      };
    })
  );
  return photos.filter((row): row is GalleryPhoto => row !== null);
}

async function runSemanticQuery(params: {
  vectorLiterals: string[];
  limit: number;
  orderBy: Prisma.Sql;
  commonFilters: Prisma.Sql[];
}) {
  const { vectorLiterals, limit, orderBy, commonFilters } = params;
  const distExpr = Prisma.sql`LEAST(${Prisma.join(
    vectorLiterals.map((literal) => Prisma.sql`(e."vector" <=> ${literal}::vector)`),
    ", "
  )})`;

  return prisma.$queryRaw<SearchRow[]>`
    SELECT
      p."id" AS "photoId",
      ${distExpr} AS "dist",
      p."createdAt" AS "createdAt",
      p."takenAt" AS "takenAt",
      p."width" AS "width",
      p."height" AS "height",
      p."cameraModel" AS "cameraModel",
      p."lensModel" AS "lensModel",
      p."iso" AS "iso",
      p."fNumber" AS "fNumber",
      p."shutter" AS "shutter",
      p."focalLength" AS "focalLength",
      thumb."key" AS "thumbKey",
      preview."key" AS "previewKey"
    FROM "Embedding" e
    JOIN "Photo" p ON p."id" = e."photoId"
    LEFT JOIN "Asset" thumb ON thumb."photoId" = p."id" AND thumb."type" = 'THUMB'::"AssetType"
    LEFT JOIN "Asset" preview ON preview."photoId" = p."id" AND preview."type" = 'PREVIEW'::"AssetType"
    WHERE e."vector" IS NOT NULL AND ${Prisma.join(commonFilters, " AND ")}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `;
}

async function runLexicalQuery(params: {
  query: string;
  tokens: string[];
  limit: number;
  commonFilters: Prisma.Sql[];
}) {
  const { query, tokens, limit, commonFilters } = params;
  if (tokens.length === 0) return [];

  const likePattern = `%${query.toLowerCase()}%`;
  const tokenArray = Prisma.sql`ARRAY[${Prisma.join(tokens.map((token) => Prisma.sql`${token}`), ", ")}]::text[]`;

  return prisma.$queryRaw<SearchRow[]>`
    SELECT
      p."id" AS "photoId",
      NULL::float8 AS "dist",
      (
        CASE
          WHEN lower(COALESCE(p."caption", '')) LIKE ${likePattern} THEN 4
          ELSE 0
        END
        +
        CASE
          WHEN p."tags" && ${tokenArray} THEN 3
          ELSE 0
        END
        +
        (
          SELECT COUNT(*)
          FROM unnest(${tokenArray}) AS t(token)
          WHERE lower(COALESCE(p."caption", '')) LIKE ('%' || t.token || '%')
             OR t.token = ANY(p."tags")
        )
      )::float8 AS "textScore",
      p."createdAt" AS "createdAt",
      p."takenAt" AS "takenAt",
      p."width" AS "width",
      p."height" AS "height",
      p."cameraModel" AS "cameraModel",
      p."lensModel" AS "lensModel",
      p."iso" AS "iso",
      p."fNumber" AS "fNumber",
      p."shutter" AS "shutter",
      p."focalLength" AS "focalLength",
      thumb."key" AS "thumbKey",
      preview."key" AS "previewKey"
    FROM "Photo" p
    LEFT JOIN "Asset" thumb ON thumb."photoId" = p."id" AND thumb."type" = 'THUMB'::"AssetType"
    LEFT JOIN "Asset" preview ON preview."photoId" = p."id" AND preview."type" = 'PREVIEW'::"AssetType"
    WHERE ${Prisma.join(commonFilters, " AND ")}
      AND (
        lower(COALESCE(p."caption", '')) LIKE ${likePattern}
        OR p."tags" && ${tokenArray}
      )
    ORDER BY "textScore" DESC, p."createdAt" DESC, p."id" DESC
    LIMIT ${limit}
  `;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  prewarmTextEmbedder();
  const q = (searchParams.get("q") ?? "").trim();
  const limit = clampLimit(searchParams.get("limit"));
  const cameraModel = (searchParams.get("cameraModel") ?? "").trim();
  const lensModel = (searchParams.get("lensModel") ?? "").trim();
  const hasGps = parseHasGps(searchParams.get("hasGps"));
  const takenAfter = parseDate(searchParams.get("takenAfter"));
  const takenBefore = parseDate(searchParams.get("takenBefore"));
  const demoOnly = searchParams.get("demoOnly") === "true";
  const sort = (searchParams.get("sort") ?? "").trim().toLowerCase();
  const maxDistance = clampMaxDistance(searchParams.get("maxDistance"));
  const semanticOnlyMaxDistance = DEFAULT_SEMANTIC_ONLY_MAX_DISTANCE;
  const semanticOnlyMinSeparation = DEFAULT_SEMANTIC_ONLY_MIN_SEPARATION;

  const commonFilters: Prisma.Sql[] = [Prisma.sql`p."status" = 'READY'::"PhotoStatus"`, Prisma.sql`thumb."key" IS NOT NULL`];
  if (cameraModel) commonFilters.push(Prisma.sql`p."cameraModel" = ${cameraModel}`);
  if (lensModel) commonFilters.push(Prisma.sql`p."lensModel" = ${lensModel}`);
  if (takenAfter) commonFilters.push(Prisma.sql`p."takenAt" >= ${takenAfter}`);
  if (takenBefore) commonFilters.push(Prisma.sql`p."takenAt" <= ${takenBefore}`);
  if (demoOnly) commonFilters.push(Prisma.sql`p."isDemo" = true`);
  if (hasGps === true) commonFilters.push(Prisma.sql`p."gpsLat" IS NOT NULL AND p."gpsLon" IS NOT NULL`);
  if (hasGps === false) commonFilters.push(Prisma.sql`(p."gpsLat" IS NULL OR p."gpsLon" IS NULL)`);

  try {
    if (!q) {
      const rows = await prisma.$queryRaw<SearchRow[]>`
        SELECT
          p."id" AS "photoId",
          NULL::float8 AS "dist",
          p."createdAt" AS "createdAt",
          p."takenAt" AS "takenAt",
          p."width" AS "width",
          p."height" AS "height",
          p."cameraModel" AS "cameraModel",
          p."lensModel" AS "lensModel",
          p."iso" AS "iso",
          p."fNumber" AS "fNumber",
          p."shutter" AS "shutter",
          p."focalLength" AS "focalLength",
          thumb."key" AS "thumbKey",
          preview."key" AS "previewKey"
        FROM "Photo" p
        LEFT JOIN "Asset" thumb ON thumb."photoId" = p."id" AND thumb."type" = 'THUMB'::"AssetType"
        LEFT JOIN "Asset" preview ON preview."photoId" = p."id" AND preview."type" = 'PREVIEW'::"AssetType"
        WHERE ${Prisma.join(commonFilters, " AND ")}
        ORDER BY p."createdAt" DESC, p."id" DESC
        LIMIT ${limit}
      `;

      const results = await mapRowsToPhotos(rows);
      return NextResponse.json({ query: q, filters: { cameraModel, lensModel, hasGps, takenAfter, takenBefore }, results });
    }

    const promptVectors = await Promise.all(buildQueryPromptEnsemble(q).map((prompt) => embedTextQuery(prompt)));
    const vectorLiterals = promptVectors.map((vector) => `[${vector.join(",")}]`);
    const orderBy =
      sort === "newest" ? Prisma.sql`p."createdAt" DESC, p."id" DESC` : Prisma.sql`"dist" ASC, p."createdAt" DESC, p."id" DESC`;
    const tokens = tokenizeQuery(q);

    if (isLowSignalQuery(q)) {
      return NextResponse.json({
        query: q,
        filters: { cameraModel, lensModel, hasGps, takenAfter, takenBefore },
        sort,
        maxDistance,
        confidence: {
          lowConfidence: true,
          reason: "low-signal-query",
        },
        results: [],
      });
    }

    const fetchLimit = Math.min(MAX_LIMIT, Math.max(limit * 3, limit));
    const [semanticRows, lexicalRows] = await Promise.all([
      runSemanticQuery({ vectorLiterals, limit: fetchLimit, orderBy, commonFilters }),
      runLexicalQuery({ query: q, tokens, limit: fetchLimit, commonFilters }),
    ]);
    const rankedRows = semanticRows.filter((row) => row.dist !== null);

    let bestDistance: number | null = null;
    let averageTopDistance: number | null = null;
    let separation: number | null = null;

    if (rankedRows.length > 0) {
      bestDistance = rankedRows.reduce((acc, row) => (row.dist! < acc ? row.dist! : acc), rankedRows[0].dist!);
      const topK = rankedRows.slice(0, Math.min(8, rankedRows.length)).map((row) => row.dist as number);
      averageTopDistance = topK.reduce((acc, value) => acc + value, 0) / topK.length;
      separation = averageTopDistance - bestDistance;
    }

    const lexicalMap = new Map<string, SearchRow>();
    for (const row of lexicalRows) lexicalMap.set(row.photoId, row);
    const hasLexicalEvidence = lexicalRows.length > 0;

    if (!hasLexicalEvidence) {
      const weakSemanticSignal =
        bestDistance === null ||
        bestDistance > semanticOnlyMaxDistance ||
        separation === null ||
        separation < semanticOnlyMinSeparation;
      if (weakSemanticSignal) {
        return NextResponse.json({
          query: q,
          filters: { cameraModel, lensModel, hasGps, takenAfter, takenBefore },
          sort,
          maxDistance,
          confidence: {
            lowConfidence: true,
            reason: "weak-semantic-only-signal",
            bestDistance,
            averageTopDistance,
            separation,
            semanticOnlyMaxDistance,
            semanticOnlyMinSeparation,
          },
          results: [],
        });
      }
    }

    const candidateMap = new Map<string, SearchRow>();
    for (const row of semanticRows) candidateMap.set(row.photoId, row);
    for (const row of lexicalRows) {
      if (!candidateMap.has(row.photoId)) candidateMap.set(row.photoId, row);
    }

    const adaptiveDistanceCeiling =
      bestDistance === null ? maxDistance : Math.min(maxDistance, bestDistance + Math.max(0.08, maxDistance * 0.2));

    const scored = [...candidateMap.values()]
      .map((row) => {
        const lexical = lexicalMap.get(row.photoId);
        const textScore = lexical?.textScore ?? 0;
        const semanticDist = row.dist ?? null;
        const semanticScore =
          semanticDist === null ? 0 : Math.max(0, 1 - Math.min(semanticDist, maxDistance * 1.6) / (maxDistance * 1.6));
        const textNormalized = Math.min(1, textScore / 8);
        const hasStrongLexical = textScore >= 2;
        const hasSemanticPass = semanticDist !== null && semanticDist <= adaptiveDistanceCeiling;
        const finalScore = semanticScore * 0.72 + textNormalized * 0.28;
        return {
          ...row,
          textScore,
          semanticDist,
          hasStrongLexical,
          hasSemanticPass,
          finalScore,
        };
      })
      .filter((row) => {
        if (!(row.hasStrongLexical || row.hasSemanticPass)) return false;
        if (row.hasStrongLexical) return row.finalScore > 0.12;
        return row.finalScore > 0.2;
      })
      .sort((a, b) => {
        if (sort === "newest") {
          const byDate = b.createdAt.getTime() - a.createdAt.getTime();
          if (byDate !== 0) return byDate;
          return a.photoId.localeCompare(b.photoId);
        }
        const byScore = b.finalScore - a.finalScore;
        if (byScore !== 0) return byScore;
        const aDist = a.dist ?? Number.POSITIVE_INFINITY;
        const bDist = b.dist ?? Number.POSITIVE_INFINITY;
        if (aDist !== bDist) return aDist - bDist;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });

    const bestFinalScore = scored[0]?.finalScore ?? null;
    const adaptiveScoreFloor = bestFinalScore === null ? 1 : Math.max(0.16, bestFinalScore * 0.55);
    const trimmed = scored.filter((row) => row.finalScore >= adaptiveScoreFloor);

    if (!trimmed.length || (bestFinalScore !== null && bestFinalScore < 0.18)) {
      return NextResponse.json({
        query: q,
        filters: { cameraModel, lensModel, hasGps, takenAfter, takenBefore },
        sort,
        maxDistance,
        confidence: {
          lowConfidence: true,
          reason: "weak-hybrid-match",
          bestDistance,
          averageTopDistance,
          separation,
          bestFinalScore,
        },
        results: [],
      });
    }

    const results = await mapRowsToPhotos(trimmed.slice(0, limit));
    return NextResponse.json({
      query: q,
      filters: { cameraModel, lensModel, hasGps, takenAfter, takenBefore },
      sort,
      maxDistance,
      confidence: {
        lowConfidence: false,
        bestDistance,
        averageTopDistance,
        separation,
        bestFinalScore,
      },
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
