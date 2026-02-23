"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type UploadItem = {
  id: string;
  fileName: string;
  progress: number;
  status: "pending" | "uploading" | "finalizing" | "queued" | "error";
  error?: string;
};

type ManagedPhoto = {
  id: string;
  thumbUrl: string;
  createdAt: string;
  isDemo: boolean;
};

function uploadFileToSignedUrl(file: File, uploadUrl: string, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable || evt.total === 0) return;
      const pct = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
      onProgress(pct);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export default function UploadClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [managedPhotos, setManagedPhotos] = useState<ManagedPhoto[]>([]);
  const [isLoadingManaged, setIsLoadingManaged] = useState(true);
  const [managedError, setManagedError] = useState<string | null>(null);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);

  function updateItem(id: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function uploadFile(file: File, id: string) {
    updateItem(id, { status: "pending", progress: 1 });

    const res = await fetch("/api/uploads/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Could not create upload: ${errorText}`);
    }

    const { uploadUrl, photoId } = await res.json();

    updateItem(id, { status: "uploading", progress: 3 });
    await uploadFileToSignedUrl(file, uploadUrl, (progress) => updateItem(id, { progress }));

    updateItem(id, { status: "finalizing", progress: 100 });
    const completeRes = await fetch("/api/uploads/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoId }),
    });
    if (!completeRes.ok) {
      const errorText = await completeRes.text();
      throw new Error(`Could not queue worker job: ${errorText}`);
    }

    updateItem(id, { status: "queued", progress: 100 });
  }

  async function handleFiles(files: File[]) {
    if (!files.length) return;

    const newItems = files.map<UploadItem>((file) => ({
      id: crypto.randomUUID(),
      fileName: file.name,
      progress: 0,
      status: "pending",
    }));
    setItems((prev) => [...newItems, ...prev]);

    for (let idx = 0; idx < files.length; idx += 1) {
      const file = files[idx];
      const item = newItems[idx];
      if (!file || !item) continue;

      try {
        await uploadFile(file, item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed";
        updateItem(item.id, { status: "error", error: message });
      }
    }

    await refreshManagedPhotos();
  }

  async function refreshManagedPhotos() {
    setIsLoadingManaged(true);
    setManagedError(null);

    try {
      let cursor: string | null = null;
      const all: ManagedPhoto[] = [];

      for (;;) {
        const url = cursor ? `/api/photos?cursor=${encodeURIComponent(cursor)}` : "/api/photos";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(await res.text());

        const payload = (await res.json()) as {
          photos?: Array<{ id: string; thumbUrl: string; createdAt: string; isDemo?: boolean }>;
          nextCursor?: string | null;
        };

        for (const photo of payload.photos ?? []) {
          all.push({ id: photo.id, thumbUrl: photo.thumbUrl, createdAt: photo.createdAt, isDemo: photo.isDemo === true });
        }

        cursor = payload.nextCursor ?? null;
        if (!cursor) break;
      }

      setManagedPhotos(all);
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : "Failed to load gallery photos");
    } finally {
      setIsLoadingManaged(false);
    }
  }

  async function removePhoto(photoId: string) {
    setDeletingPhotoId(photoId);
    setManagedError(null);
    try {
      const res = await fetch(`/api/photos/${photoId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setManagedPhotos((prev) => prev.filter((photo) => photo.id !== photoId));
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : "Failed to delete photo");
    } finally {
      setDeletingPhotoId(null);
    }
  }

  async function setPhotoDemo(photoId: string, isDemo: boolean) {
    setManagedError(null);
    try {
      const res = await fetch(`/api/photos/${photoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDemo }),
      });
      if (!res.ok) throw new Error(await res.text());
      setManagedPhotos((prev) => prev.map((photo) => (photo.id === photoId ? { ...photo, isDemo } : photo)));
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : "Failed to update demo status");
    }
  }

  useEffect(() => {
    void refreshManagedPhotos();
  }, []);

  const queuedCount = useMemo(() => items.filter((item) => item.status === "queued").length, [items]);

  return (
    <div className="min-h-screen bg-black px-6 py-12 text-white md:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-3">
          <Link href="/" className="rounded-none border border-white px-3 py-2 text-sm text-white hover:bg-white hover:text-black">
            Home
          </Link>
          <Link href="/gallery" className="rounded-none border border-white px-3 py-2 text-sm text-white hover:bg-white hover:text-black">
            Gallery
          </Link>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Upload Archive</h1>
        <p className="mt-2 text-sm text-neutral-300">
          Drop raws or JPEGs. Originals go to object storage and each upload is queued for processing.
        </p>

        <button
          type="button"
          className={`mt-8 w-full rounded-none border border-dashed px-6 py-16 text-left transition ${
            isDragging ? "border-white bg-white/10" : "border-white/40 bg-black hover:border-white"
          }`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            void handleFiles(Array.from(e.dataTransfer.files ?? []));
          }}
        >
          <div className="text-lg font-medium">Drag and drop photos here</div>
          <div className="mt-1 text-sm text-neutral-300">or click to select files</div>
        </button>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(Array.from(e.target.files ?? []));
            e.currentTarget.value = "";
          }}
        />

        <div className="mt-6 flex items-center justify-between text-xs uppercase tracking-wide text-neutral-300">
          <span>Uploads</span>
          <span>{queuedCount} queued</span>
        </div>

        <div className="mt-3 space-y-3">
          {items.length === 0 ? (
            <div className="rounded-none border border-white/30 bg-black p-4 text-sm text-neutral-300">
              No uploads yet.
            </div>
          ) : null}

          {items.map((item) => (
            <div key={item.id} className="rounded-none border border-white/30 bg-black p-4">
              <div className="flex items-start justify-between gap-4">
                <p className="min-w-0 truncate text-sm">{item.fileName}</p>
                <p className="text-xs uppercase tracking-wide text-neutral-300">{item.status}</p>
              </div>
              <div className="mt-3 h-2 rounded-none bg-white/15">
                <div className="h-2 rounded-none bg-white transition-all" style={{ width: `${item.progress}%` }} />
              </div>
              {item.error ? <p className="mt-2 text-xs text-rose-300">{item.error}</p> : null}
            </div>
          ))}
        </div>

        <div className="mt-10 flex items-center justify-between text-xs uppercase tracking-wide text-neutral-300">
          <span>Gallery Photos</span>
          <button
            type="button"
            className="rounded-none border border-white px-3 py-2 text-[11px] hover:bg-white hover:text-black"
            onClick={() => void refreshManagedPhotos()}
          >
            Refresh
          </button>
        </div>

        {managedError ? <p className="mt-3 text-sm text-rose-300">{managedError}</p> : null}

        {isLoadingManaged ? (
          <div className="mt-3 border border-white/30 p-4 text-sm text-neutral-300">Loading photos…</div>
        ) : null}

        {!isLoadingManaged && managedPhotos.length === 0 ? (
          <div className="mt-3 border border-white/30 p-4 text-sm text-neutral-300">No gallery photos yet.</div>
        ) : null}

        {!isLoadingManaged && managedPhotos.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
            {managedPhotos.map((photo) => (
              <div key={photo.id} className="border border-white/30 bg-black p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.thumbUrl} alt={photo.id} className="h-36 w-full object-cover" />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="truncate text-xs text-neutral-300">{new Date(photo.createdAt).toLocaleDateString()}</p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className={`rounded-none border px-2 py-1 text-[11px] ${
                        photo.isDemo ? "border-emerald-400 text-emerald-300" : "border-white text-white hover:bg-white hover:text-black"
                      }`}
                      onClick={() => void setPhotoDemo(photo.id, !photo.isDemo)}
                    >
                      {photo.isDemo ? "Demo ✓" : "Set Demo"}
                    </button>
                    <button
                      type="button"
                      className="rounded-none border border-white px-2 py-1 text-[11px] hover:bg-white hover:text-black disabled:opacity-50"
                      disabled={deletingPhotoId === photo.id}
                      onClick={() => void removePhoto(photo.id)}
                    >
                      {deletingPhotoId === photo.id ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
