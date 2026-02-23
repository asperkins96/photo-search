"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GalleryPhoto } from "@/lib/gallery";

type GalleryClientProps = {
  initialPhotos: GalleryPhoto[];
  initialCursor: string | null;
  initialQuery?: string;
  initialDemoOnly?: boolean;
};

type ViewerState = {
  collection: "archive" | "results";
  index: number;
} | null;

type TileLayout = {
  photo: GalleryPhoto;
  idx: number;
  rank: number | undefined;
  motion: string;
  rotateDeg: number;
  leftPct: number;
  topPct: number;
  widthPx: number;
  heightPx?: number;
  opacity?: number;
  zIndex: number;
};

const ORBIT_ANIMATIONS = ["", "", "", ""];
const HERO_TILE_LIMIT = 1000;
const SEARCH_TILE_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 850;
const TILE_ANIMATION_MS = 1150;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 4) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function hashString(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
}

function pointOnEllipse(cx: number, cy: number, rx: number, ry: number, angle: number) {
  return {
    x: cx + rx * Math.cos(angle),
    y: cy + ry * Math.sin(angle),
  };
}

function intersectsRect(
  x: number,
  y: number,
  w: number,
  h: number,
  rect: { left: number; right: number; top: number; bottom: number }
) {
  const left = x - w / 2;
  const right = x + w / 2;
  const top = y - h / 2;
  const bottom = y + h / 2;
  return !(right < rect.left || left > rect.right || bottom < rect.top || top > rect.bottom);
}

function formatDate(iso: string | null) {
  if (!iso) return "Unknown date";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatExif(photo: GalleryPhoto) {
  const parts: string[] = [];
  if (photo.cameraModel) parts.push(photo.cameraModel);
  if (photo.lensModel) parts.push(photo.lensModel);
  if (photo.fNumber) parts.push(`f/${photo.fNumber}`);
  if (photo.shutter) parts.push(photo.shutter);
  if (photo.iso) parts.push(`ISO ${photo.iso}`);
  if (photo.focalLength) parts.push(`${photo.focalLength}mm`);
  return parts.length ? parts.join(" · ") : "No EXIF details";
}

function uniqueByPhotoId(items: GalleryPhoto[]) {
  const seen = new Set<string>();
  const deduped: GalleryPhoto[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function getTileWidth(photo: GalleryPhoto, viewportWidth: number, visibleCount: number, isSearchActive: boolean) {
  const ratio = photo.width && photo.height ? photo.width / photo.height : 0.8;
  const viewportScale = clamp(viewportWidth / 1600, 0.9, 1.25);
  const densityBase = visibleCount <= 4 ? 460 : visibleCount <= 8 ? 390 : visibleCount <= 14 ? 330 : 285;
  const zoomBoost = isSearchActive ? 1.04 : 1;
  const base = densityBase * viewportScale * zoomBoost;
  const maxWidth = Math.max(220, viewportWidth * (isSearchActive ? 0.24 : 0.2));
  return Math.max(96, Math.min(maxWidth, base * ratio));
}

const DEMO_QUERY_CHIPS = ["couple", "night portrait", "boat", "street scene", "kissing", "golden hour"];

export default function GalleryClient({
  initialPhotos,
  initialCursor: _initialCursor,
  initialQuery = "",
  initialDemoOnly = false,
}: GalleryClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const photos = initialPhotos;
  const [viewport, setViewport] = useState({ width: 1440, height: 900 });
  const [isMounted, setIsMounted] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialQuery);
  const [results, setResults] = useState<GalleryPhoto[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [modeLabel, setModeLabel] = useState<string | null>(null);
  const [modeTransition, setModeTransition] = useState<"idle" | "to-search" | "to-orbit">("idle");
  const [viewer, setViewer] = useState<ViewerState>(null);
  const [demoOnly, setDemoOnly] = useState(initialDemoOnly);

  const hasPhotos = photos.length > 0;
  const isQueryPending = searchQuery.trim() !== debouncedSearchQuery;
  const hasCommittedQuery = debouncedSearchQuery.length > 0;
  const isSearchResolved = hasCommittedQuery && !isQueryPending;
  const isSearchActive = isSearchResolved || !!modeLabel;
  const demoMode = demoOnly;

  useEffect(() => {
    setDemoOnly(initialDemoOnly);
  }, [initialDemoOnly]);

  const uniqueSearchResults = useMemo(() => uniqueByPhotoId(results), [results]);
  const isNoResultsState = isSearchActive && !isSearching && !isQueryPending && !searchError && uniqueSearchResults.length === 0;
  const hasSearchGrid = isSearchActive && !isSearching && !isQueryPending && uniqueSearchResults.length > 0;
  const noSearchSourcePhotos = useMemo(() => photos.slice(0, HERO_TILE_LIMIT), [photos]);

  const orbitPhotos = useMemo(() => {
    if (isSearchActive) return uniqueSearchResults.slice(0, SEARCH_TILE_LIMIT);
    return noSearchSourcePhotos;
  }, [isSearchActive, uniqueSearchResults, noSearchSourcePhotos]);

  const visibleImageCount = Math.max(1, orbitPhotos.length);

  const resultRankById = useMemo(() => {
    const rank = new Map<string, number>();
    uniqueSearchResults.forEach((photo, idx) => rank.set(photo.id, idx));
    return rank;
  }, [uniqueSearchResults]);

  const noSearchOrbitTiles = useMemo<TileLayout[]>(() => {
    const vw = viewport.width;
    const vh = viewport.height;
    const items = noSearchSourcePhotos;
    const total = items.length;
    if (total === 0) return [];

    const sideMargin = 24;
    const topMargin = 56;
    const bottomMargin = 40;
    const gap = 8;
    const centerY = vh * 0.5;
    const centerX = vw * 0.5;
    const zoneTop = centerY - 86;
    const zoneBottom = centerY + 86;
    const searchZone = {
      left: centerX - Math.min(vw * 0.24, 330),
      right: centerX + Math.min(vw * 0.24, 330),
      top: zoneTop,
      bottom: zoneBottom,
    };

    const ringCount = Math.max(4, Math.min(12, Math.ceil(total / 7)));
    const ringRxMin = vw * 0.24;
    const ringRxMax = vw * 0.5;
    const ringRyMin = vh * 0.23;
    const ringRyMax = vh * 0.49;
    const rxStep = ringCount > 1 ? (ringRxMax - ringRxMin) / (ringCount - 1) : 0;
    const ryStep = ringCount > 1 ? (ringRyMax - ringRyMin) / (ringCount - 1) : 0;

    const perRing = Array.from({ length: ringCount }, (_, i) => {
      if (i === ringCount - 1) return 0;
      const weight = i === 0 ? 0.18 : i === 1 ? 0.16 : i === 2 ? 0.14 : 0.12;
      return Math.max(4, Math.round(total * weight));
    });
    const allocated = perRing.reduce((acc, n) => acc + n, 0);
    perRing[ringCount - 1] = Math.max(0, total - allocated);
    const ringStarts = perRing.reduce<number[]>((acc, n, i) => {
      if (i === 0) return [0];
      acc.push(acc[i - 1]! + perRing[i - 1]!);
      return acc;
    }, []);

    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];

    const layouts: TileLayout[] = [];

    items.forEach((photo, idx) => {
      const hash = hashString(photo.id);
      const noise = ((hash % 1000) / 1000 - 0.5) * 0.12;
      const rotateDeg = ((hash % 1000) / 1000 - 0.5) * 6;
      let ring = ringCount - 1;
      for (let r = 0; r < ringCount; r += 1) {
        const start = ringStarts[r]!;
        const end = start + perRing[r]!;
        if (idx >= start && idx < end) {
          ring = r;
          break;
        }
      }

      const ringItems = Math.max(1, perRing[ring]!);
      const ringIndex = idx - ringStarts[ring]!;
      const startAngle = ((Math.PI * 2) / ringItems) * ringIndex - Math.PI / 2 + ring * 0.45 + noise;
      const baseRx = ringRxMin + rxStep * ring;
      const baseRy = ringRyMin + ryStep * ring;

      const ratio = photo.width && photo.height ? photo.width / photo.height : 0.8;
      const tierScale = total <= 14 ? (idx < 3 ? 1.32 : idx < 8 ? 1.12 : 0.95) : total <= 24 ? (idx < 4 ? 1.18 : 0.9) : 0.78;
      let widthPx = getTileWidth(photo, vw, visibleImageCount, false) * tierScale;
      let heightPx = widthPx / Math.max(ratio, 0.38);

      let x = centerX;
      let y = centerY;
      let angle = startAngle;
      let solved = false;

      for (let attempt = 0; attempt < 180; attempt += 1) {
        const sweep = (Math.PI * 2 * attempt) / ringItems;
        const radialPulse = 1 + ((attempt % 7) - 3) * 0.03 + attempt * 0.0035;
        const point = pointOnEllipse(centerX, centerY, baseRx * radialPulse, baseRy * radialPulse, angle + sweep);
        x = clamp(point.x, sideMargin + widthPx / 2, vw - sideMargin - widthPx / 2);
        y = clamp(point.y, topMargin + heightPx / 2, vh - bottomMargin - heightPx / 2);

        const collidesZone = intersectsRect(x, y, widthPx, heightPx, searchZone);
        const collidesPhoto = placed.some(
          (other) =>
            Math.abs(other.x - x) < (other.w + widthPx) / 2 + gap &&
            Math.abs(other.y - y) < (other.h + heightPx) / 2 + gap
        );
        if (!collidesZone && !collidesPhoto) {
          solved = true;
          break;
        }

        if (attempt > 0 && attempt % 16 === 0) {
          widthPx = Math.max(64, widthPx * 0.9);
          heightPx = widthPx / Math.max(ratio, 0.38);
          angle += 0.15;
        }
      }

      if (!solved) {
        widthPx = Math.max(56, widthPx * 0.88);
        heightPx = widthPx / Math.max(ratio, 0.38);
      }

      placed.push({ x, y, w: widthPx, h: heightPx });
      const rank = resultRankById.get(photo.id);

      layouts.push({
        photo,
        idx,
        rank,
        motion: ORBIT_ANIMATIONS[idx % ORBIT_ANIMATIONS.length]!,
        rotateDeg,
        leftPct: round((x / vw) * 100, 4),
        topPct: round((y / vh) * 100, 4),
        widthPx: round(widthPx, 3),
        zIndex: 16 + (total - idx),
      } satisfies TileLayout);
    });

    return layouts;
  }, [noSearchSourcePhotos, resultRankById, viewport, visibleImageCount]);

  const searchGridTiles = useMemo<TileLayout[]>(() => {
    if (!hasSearchGrid) return [];

    const vw = viewport.width;
    const vh = viewport.height;
    const items = uniqueSearchResults.slice(0, SEARCH_TILE_LIMIT);
    const total = items.length;
    if (total === 0) return [];

    const paddingX = 30;
    const topPad = 210;
    const bottomPad = 22;
    const gap = 12;
    const areaW = Math.max(320, vw - paddingX * 2);
    const areaH = Math.max(220, vh - topPad - bottomPad);

    let bestCols = 1;
    let bestRows = total;
    let bestCellScore = 0;

    const maxCols = Math.min(12, total);
    for (let cols = 1; cols <= maxCols; cols += 1) {
      const rows = Math.ceil(total / cols);
      const cellW = (areaW - gap * (cols - 1)) / cols;
      const cellH = (areaH - gap * (rows - 1)) / rows;
      const score = Math.min(cellW, cellH);
      if (score > bestCellScore) {
        bestCellScore = score;
        bestCols = cols;
        bestRows = rows;
      }
    }

    const cols = bestCols;
    const rows = bestRows;
    const cellW = (areaW - gap * (cols - 1)) / cols;
    const cellH = (areaH - gap * (rows - 1)) / rows;
    const cardW = Math.max(56, cellW);
    const cardH = Math.max(56, cellH);

    return items.map((photo, idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const cellLeft = paddingX + col * (cellW + gap);
      const cellTop = topPad + row * (cellH + gap);
      const x = cellLeft + cellW / 2;
      const y = cellTop + cellH / 2;

      return {
        photo,
        idx,
        rank: resultRankById.get(photo.id),
        motion: "",
        rotateDeg: 0,
        leftPct: round((x / vw) * 100, 4),
        topPct: round((y / vh) * 100, 4),
        widthPx: round(cardW, 3),
        heightPx: round(cardH, 3),
        zIndex: 20 + (total - idx),
      } satisfies TileLayout;
    });
  }, [hasSearchGrid, resultRankById, uniqueSearchResults, viewport]);

  useEffect(() => {
    setModeTransition(hasSearchGrid ? "to-search" : "to-orbit");
    const id = setTimeout(() => setModeTransition("idle"), TILE_ANIMATION_MS + 80);
    return () => clearTimeout(id);
  }, [hasSearchGrid]);

  const displayTiles = useMemo<TileLayout[]>(() => {
    if (isNoResultsState) return [];
    if (!hasSearchGrid) return noSearchOrbitTiles.map((tile) => ({ ...tile, opacity: 1 }));

    const searchIds = new Set(searchGridTiles.map((tile) => tile.photo.id));
    const base = searchGridTiles.map((tile) => ({ ...tile, opacity: 1 }));
    if (modeTransition !== "to-search") return base;

    const fading = noSearchOrbitTiles
      .filter((tile) => !searchIds.has(tile.photo.id))
      .map((tile) => ({ ...tile, opacity: 0, zIndex: 6 }));
    return [...base, ...fading];
  }, [hasSearchGrid, isNoResultsState, modeTransition, noSearchOrbitTiles, searchGridTiles]);

  const viewerCollection = viewer?.collection === "results" ? uniqueSearchResults : photos;
  const openPhoto = viewer ? viewerCollection[viewer.index] ?? null : null;
  const canGoPrev = !!viewer && viewer.index > 0;
  const canGoNext = !!viewer && viewer.index < viewerCollection.length - 1;

  function clearSearch() {
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setResults([]);
    setModeLabel(null);
    setSearchError(null);
  }

  function setMode(nextDemoOnly: boolean) {
    setDemoOnly(nextDemoOnly);
    const params = new URLSearchParams(searchParams.toString());
    if (nextDemoOnly) params.set("mode", "demo");
    else params.delete("mode");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  async function findSimilar(photo: GalleryPhoto) {
    const params = new URLSearchParams({
      photoId: photo.id,
      limit: "20",
    });
    if (demoOnly) params.set("demoOnly", "true");
    const res = await fetch(`/api/similar?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return;
    const payload = (await res.json()) as { results: GalleryPhoto[] };
    const deduped = uniqueByPhotoId(payload.results.filter((item) => item.id !== photo.id));
    setResults([photo, ...deduped]);
    setModeLabel(`Similar to ${photo.id.slice(0, 8)}`);
    setViewer({ collection: "results", index: 0 });
  }

  useEffect(() => {
    setIsMounted(true);

    function onResize() {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }

    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (viewer) return;
    const id = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [viewer, isSearchActive]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function refreshResults() {
      if (!debouncedSearchQuery) {
        if (!modeLabel) setResults([]);
        setSearchError(null);
        setIsSearching(false);
        return;
      }

      setModeLabel(null);
      setIsSearching(true);
      setSearchError(null);

      try {
        const queryParams = new URLSearchParams({
          q: debouncedSearchQuery,
          limit: String(SEARCH_TILE_LIMIT),
        });
        if (demoOnly) queryParams.set("demoOnly", "true");

        const res = await fetch(`/api/search?${queryParams.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await res.json()) as { results?: GalleryPhoto[]; error?: string };

        if (!res.ok) {
          if (!cancelled) setSearchError(payload.error ?? "Search request failed");
          return;
        }

        if (!cancelled) setResults(uniqueByPhotoId(payload.results ?? []));
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
          setSearchError(error instanceof Error ? error.message : "Search request failed");
        }
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }

    void refreshResults();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedSearchQuery, modeLabel, demoOnly]);

  useEffect(() => {
    if (!isSearchActive) return;
    function onWheel(event: WheelEvent) {
      if (Math.abs(event.deltaY) > 6) clearSearch();
    }
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [isSearchActive]);

  useEffect(() => {
    if (!isSearchActive) return;

    function onKeyDown(event: KeyboardEvent) {
      if (viewer) return;
      const target = event.target as HTMLElement | null;
      const inInput = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inInput) return;

      if (event.key === "Enter") {
        event.preventDefault();
        return;
      }

      const isPlainChar = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isPlainChar) return;

      event.preventDefault();
      setModeLabel(null);
      setSearchQuery(event.key);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSearchActive, viewer]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!viewer) return;
      if (event.key === "Escape") setViewer(null);
      if (event.key === "ArrowLeft" && canGoPrev) setViewer((prev) => (prev ? { ...prev, index: prev.index - 1 } : null));
      if (event.key === "ArrowRight" && canGoNext) setViewer((prev) => (prev ? { ...prev, index: prev.index + 1 } : null));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewer, canGoPrev, canGoNext]);

  useEffect(() => {
    if (!viewer) return;
    const next = viewerCollection[viewer.index + 1]?.previewUrl;
    const prev = viewerCollection[viewer.index - 1]?.previewUrl;
    if (next) {
      const img = new Image();
      img.src = next;
    }
    if (prev) {
      const img = new Image();
      img.src = prev;
    }
  }, [viewer, viewerCollection]);

  if (!hasPhotos) {
    return (
      <div className="mx-auto flex h-screen w-full max-w-5xl flex-col items-center justify-center px-6 text-center text-white">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">Start</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-tight">{demoMode ? "No Demo Photos Yet" : "Upload Your First Photos"}</h1>
        <p className="mt-4 max-w-2xl text-neutral-400">
          {demoMode
            ? "Demo set is enabled, but no photos are marked for demo. Mark photos as Demo from the Upload page."
            : "This screen transforms into your live semantic search board once your first batch is processed."}
        </p>
        <div className="mt-8 flex items-center gap-3">
          {demoMode ? (
            <button
              type="button"
              onClick={() => setMode(false)}
              className="rounded-none border border-white px-5 py-3 text-sm hover:bg-white hover:text-black"
            >
              View All Photos
            </button>
          ) : null}
          <Link href="/upload" className="rounded-none border border-white px-5 py-3 text-sm hover:bg-white hover:text-black">
            Upload
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="absolute left-0 top-0 z-30 w-full px-6 py-4 md:px-8">
        <div className="flex w-full items-start justify-between text-white">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-neutral-400">Photo Archive Search</p>
            {/* <p className="mt-2 max-w-md text-sm text-neutral-300">Zoom search into matching photos. Scroll wheel or Back zooms out.</p>
            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-neutral-500">
              {demoMode ? "Viewing Demo Set" : "Viewing All Photos"}
            </p> */}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode(!demoMode)}
              className="rounded-none border border-white px-3 py-2 text-sm hover:bg-white hover:text-black"
            >
              {demoMode ? "All Photos" : "Demo Set"}
            </button>
            {isSearchActive ? (
              <button
                type="button"
                onClick={clearSearch}
                className="rounded-none border border-white px-3 py-2 text-sm hover:bg-white hover:text-black"
              >
                Back
              </button>
            ) : null}
            <Link href="/upload" className="rounded-none border border-white px-3 py-2 text-sm hover:bg-white hover:text-black">
              Upload
            </Link>
          </div>
        </div>
      </header>

      <main className="relative h-screen overflow-hidden bg-black">
        <div className="pointer-events-none absolute inset-0 z-10">
          {isMounted
            ? displayTiles.map((tile) => (
                <button
                  key={tile.photo.id}
                  type="button"
                  className={`pointer-events-auto absolute left-0 top-0 transform-gpu will-change-transform transition-[transform,opacity,width,height] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${tile.motion} ${
                    hasSearchGrid ? "scale-[1.02]" : "scale-100"
                  }`}
                  style={{
                    transform: `translate3d(${round((tile.leftPct / 100) * viewport.width, 3)}px, ${round((tile.topPct / 100) * viewport.height, 3)}px, 0) translate(-50%, -50%)`,
                    width: `${tile.widthPx}px`,
                    zIndex: tile.zIndex,
                    opacity: tile.opacity ?? 1,
                    transitionDuration: `${TILE_ANIMATION_MS}ms`,
                  }}
                  onClick={() => {
                    if (hasSearchGrid) {
                      const resultIndex = uniqueSearchResults.findIndex((item) => item.id === tile.photo.id);
                      if (resultIndex >= 0) setViewer({ collection: "results", index: resultIndex });
                    } else {
                      const archiveIndex = photos.findIndex((item) => item.id === tile.photo.id);
                      if (archiveIndex >= 0) setViewer({ collection: "archive", index: archiveIndex });
                    }
                  }}
                >
                  {hasSearchGrid ? (
                    <div
                      className="overflow-hidden rounded-sm shadow-[0_12px_24px_rgba(0,0,0,0.5)]"
                      style={{ height: `${tile.heightPx ?? Math.round(tile.widthPx * 1.25)}px` }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={tile.photo.thumbUrl}
                        alt=""
                        className="block h-full w-full select-none object-contain"
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                  ) : (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={tile.photo.thumbUrl}
                        alt=""
                        className="block h-auto w-full select-none drop-shadow-[0_16px_28px_rgba(0,0,0,0.5)]"
                        style={{ transform: `rotate(${round(tile.rotateDeg, 2)}deg)` }}
                        loading="lazy"
                        decoding="async"
                      />
                    </>
                  )}
                </button>
              ))
            : null}
        </div>
        <div
          className={`absolute left-1/2 z-40 flex w-[min(100%-3rem,40rem)] flex-col items-center text-white transition-[top,transform] duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
            isSearchActive ? "top-16 -translate-x-1/2 translate-y-0" : "top-1/2 -translate-x-1/2 -translate-y-1/2"
          }`}
        >
            <p className="mb-3 text-xs uppercase tracking-[0.22em] text-neutral-400">Photo Search</p>
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && isSearchActive) {
                  setSearchQuery(debouncedSearchQuery);
                }
              }}
              placeholder='Search by keyword or description'
              className="w-full rounded-none border border-white bg-black/95 px-4 py-3 text-base placeholder:text-neutral-500 focus:outline-none"
            />
            {demoMode && !isSearchActive ? (
              <div className="mt-3 flex w-full flex-wrap items-center justify-center gap-2">
                {DEMO_QUERY_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="border border-white/40 px-2 py-1 text-xs uppercase tracking-[0.14em] text-neutral-300 transition hover:border-white hover:text-white"
                    onClick={() => setSearchQuery(chip)}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            ) : null}
            {isSearchActive ? <p className="mt-1 text-xs text-neutral-500">Search updates after you pause typing.</p> : null}
            {isSearching || isQueryPending ? <p className="mt-3 text-sm text-neutral-400">Searching...</p> : null}
            {searchError ? <p className="mt-3 text-sm text-rose-300">{searchError}</p> : null}
            {isNoResultsState ? <p className="mt-3 text-sm text-neutral-300">No results found. Try a different keyword.</p> : null}
            {modeLabel ? <p className="mt-2 text-xs text-neutral-400">{modeLabel}</p> : null}
            {isSearchActive && !isSearching && !searchError ? (
              <p className="mt-1 text-xs uppercase tracking-[0.2em] text-neutral-500">
                {uniqueSearchResults.length} result{uniqueSearchResults.length === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>
      </main>

      {openPhoto && viewer ? (
        <div className="fixed inset-0 z-50 bg-black/88 p-4 md:p-8" role="dialog" aria-modal="true" onClick={() => setViewer(null)}>
          <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 md:flex-row" onClick={(event) => event.stopPropagation()}>
            <div className="relative min-h-[50vh] flex-1 overflow-hidden rounded-2xl bg-neutral-950">
              <button
                type="button"
                className="absolute right-3 top-3 z-10 rounded-none border border-neutral-500 bg-black/50 px-3 py-1 text-sm text-neutral-100"
                onClick={() => setViewer(null)}
              >
                Close (Esc)
              </button>
              {openPhoto.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={openPhoto.previewUrl} alt={`Preview ${openPhoto.id}`} className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-neutral-400">Preview unavailable</div>
              )}
            </div>

            <aside className="w-full rounded-2xl bg-neutral-950 p-4 text-sm text-neutral-200 md:w-80">
              <p className="text-xs uppercase tracking-[0.18em] text-neutral-400">Photo Details</p>
              <p className="mt-3">{formatDate(openPhoto.takenAt ?? openPhoto.createdAt)}</p>
              <p className="mt-2 text-neutral-400">{formatExif(openPhoto)}</p>
              <p className="mt-2 text-neutral-400">{openPhoto.width && openPhoto.height ? `${openPhoto.width} × ${openPhoto.height}` : "Unknown dimensions"}</p>

              <div className="mt-6 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-none border border-neutral-700 px-3 py-2 text-sm hover:border-neutral-500 disabled:opacity-40"
                  onClick={() => setViewer((prev) => (prev ? { ...prev, index: prev.index - 1 } : null))}
                  disabled={!canGoPrev}
                >
                  Prev (←)
                </button>
                <button
                  type="button"
                  className="rounded-none border border-neutral-700 px-3 py-2 text-sm hover:border-neutral-500 disabled:opacity-40"
                  onClick={() => setViewer((prev) => (prev ? { ...prev, index: prev.index + 1 } : null))}
                  disabled={!canGoNext}
                >
                  Next (→)
                </button>
                <button
                  type="button"
                  className="rounded-none border border-neutral-400/60 bg-neutral-100/10 px-3 py-2 text-sm text-neutral-100 hover:border-neutral-300"
                  onClick={() => void findSimilar(openPhoto)}
                >
                  Find Similar
                </button>
              </div>
            </aside>
          </div>
        </div>
      ) : null}
    </>
  );
}
