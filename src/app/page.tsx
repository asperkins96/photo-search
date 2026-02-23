import GalleryClient from "./gallery/GalleryClient";
import { getGalleryPage } from "@/lib/gallery";
import { isDemoModeDefault } from "@/lib/runtime";

export const dynamic = "force-dynamic";

type HomePageProps = {
  searchParams: Promise<{ q?: string; mode?: string }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const demoModeDefault = isDemoModeDefault();
  const modeParam = (params.mode ?? "").trim().toLowerCase();
  const demoOnly = modeParam ? modeParam === "demo" : demoModeDefault;
  const { photos, nextCursor } = await getGalleryPage(undefined, { demoOnly });

  return (
    <div className="min-h-screen bg-black text-neutral-100">
      <GalleryClient
        initialPhotos={photos}
        initialCursor={nextCursor}
        initialQuery={q}
        initialDemoOnly={demoOnly}
      />
    </div>
  );
}
