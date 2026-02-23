import { redirect } from "next/navigation";

type GalleryRouteProps = {
  searchParams: Promise<{ q?: string }>;
};

export default async function LegacyGalleryRoute({ searchParams }: GalleryRouteProps) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  if (q) {
    redirect(`/?q=${encodeURIComponent(q)}`);
  }
  redirect("/");
}
