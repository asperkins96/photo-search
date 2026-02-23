# Photo Search

Photo archive app with:
- direct uploads to R2
- background processing (EXIF + derivatives + CLIP embeddings + AI captions/tags)
- semantic search and similar-image search
- gallery viewer with filters and keyboard navigation

## Stack
- Next.js App Router + TypeScript
- Postgres + pgvector + Prisma
- Redis + BullMQ worker
- Cloudflare R2 (originals + derivatives)
- Python OpenCLIP embedder

## Prerequisites
- Node.js (20+ recommended)
- Python 3.10+
- Docker

## Environment
1. Copy `.env.example` to `.env.local`.
2. Fill in R2 credentials and bucket names.
3. Ensure your R2 token has:
   - read/write for originals bucket
   - read/write for derivatives bucket

## Install
```bash
npm install
```

## Database migration
Apply latest schema updates before running the worker:
```bash
npx prisma migrate dev
```

## Python embedder setup
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r embedder/requirements.txt
```

## Run locally
Terminal 1:
```bash
docker compose up -d
```

Terminal 2:
```bash
npm run dev
```

Terminal 3:
```bash
npm run worker:dev
```

## Deploy on Railway (Web + Worker)
Use two Railway services from the same repo:

1. `web` service
- Source: this repo
- Dockerfile path: `Dockerfile.web`
- Exposes HTTP on `PORT` (Railway sets this automatically)

2. `worker` service
- Source: this repo
- Dockerfile path: `Dockerfile.worker`
- No public networking required

Also add managed services in the same Railway project:
- PostgreSQL
- Redis

Set these environment variables on **both** `web` and `worker`:
- `DATABASE_URL` -> from Railway PostgreSQL service
- `REDIS_URL` -> from Railway Redis service
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_ORIGINALS`
- `R2_BUCKET_DERIVATIVES`
- `R2_PUBLIC_DERIVATIVES_BASE_URL` (recommended for gallery speed)
- `EMBED_PYTHON_BIN=python3`

Optional demo switch (recommended for portfolio demos):
- `DEMO_MODE=true`

### Railway launch order
1. Provision Postgres + Redis.
2. Deploy `web`.
3. Deploy `worker`.
4. Upload demo photos once, let queue process to `READY`.
5. Share web service URL.

### Demo mode behavior
When `DEMO_MODE=true`:
- homepage defaults to demo set view (`?mode=demo`)
- a live toggle lets users switch between `Demo Set` and `All Photos`
- upload/delete remain available
- quick search chips are shown for fast walkthroughs
- mark/unmark photos as demo from `/upload`

### Curating the demo set
1. Upload photos normally at `/upload`.
2. In the `Gallery Photos` manager, click `Set Demo` on photos you want in the showcase set.
3. On `/`, click the `Demo Set` toggle in the header to view only curated demo photos.
4. Share `/` (or `/?mode=demo`) for portfolio walkthroughs.

## Workflow
1. Open `http://localhost:3000/upload`
2. Upload photos
3. Check queue health: `http://localhost:3000/api/debug/queue`
4. Open `http://localhost:3000/gallery`
5. Search with text or use viewer `Find Similar`

## Useful endpoints
- `GET /api/debug/queue`
- `GET /api/photos`
- `GET /api/photos/:photoId/status`
- `GET /api/search?q=portrait&cameraModel=...&hasGps=true`
- `GET /api/similar?photoId=...&limit=10`
- `GET /api/facets/cameras`
- `GET /api/facets/lenses`

## Verification checklist
- Upload completes and queue `completed` increases.
- `Photo.status` reaches `READY`.
- `Asset` has `THUMB` + `PREVIEW`.
- `Embedding.vector` exists (512 dimensions).
- `Photo.caption` and `Photo.tags` are populated.
- `/gallery` supports:
  - search
  - camera/lens/date/location filters
  - viewer (`Esc`, `←`, `→`)
  - `Find Similar`
