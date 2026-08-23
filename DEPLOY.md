# Deploy (Render)

This repo deploys to Render as a **Blueprint** (`render.yaml`) with two services:

| Service          | Type         | Purpose                                  | URL pattern                          |
| ---------------- | ------------ | ---------------------------------------- | ------------------------------------ |
| `elim-ims-project` | Static Site | Vite + React frontend (`client/`)        | `https://elim-ims-project.onrender.com` |
| `elim-erp-api`     | Web Service | Express API + SQLite (`server/`)         | `https://elim-erp-api.onrender.com`     |

The API is self-contained: it migrates and seeds its own SQLite database at
boot (`node:sqlite`), so **no external database is required**.

## Deploy steps

1. Render dashboard → **New → Blueprint** → connect
   `Shieldnetcore-Team-Project/elim-ims-project`.
2. Review the two services and click **Apply**.
3. When prompted for `VITE_API_URL` (the static site's env var), enter the API
   URL, e.g. `https://elim-erp-api.onrender.com`. If you skip it, set it later
   in the static site's **Environment** and redeploy.
4. Wait for both builds. The API runs `migrate()` + `seed()` on first boot.

> Blueprint (`render.yaml`) is only used when you create via **New → Blueprint**.
> Services created manually (New → Web Service / Static Site) ignore this file —
> set the values by hand in that case (see below).

## Key settings

**Static site (`elim-ims-project`)**
- Build Command: `npm install && npm run build -w client`
- Publish Directory: `dist` (Vite is configured to output to repo-root `dist`)
- Env: `VITE_API_URL` — base URL of the API. Inlined at build time, so
  **redeploy the static site** after changing it.

**Web service (`elim-erp-api`)**
- Root Directory: `server`
- Build Command: `npm install && npm run build`
- Start Command: `node --experimental-sqlite dist/index.js`
  (Node 22 needs the flag for `node:sqlite`)
- Health Check Path: `/api/health`
- Env: `NODE_VERSION=22`, `ELIM_DB_PATH=/data/elim.db`
- Plan: `starter` (required — see Persistence)
- Disk: `elim-api-data` mounted at `/data` (1 GB)

## Frontend → API wiring

All API calls go through `client/src/lib/apiClient.ts`, which prefixes requests
with `VITE_API_URL` when set and falls back to relative `/api` (handled by the
Vite dev proxy) when unset. In production the two services are on different
origins, so `VITE_API_URL` must point at the deployed API. CORS on the API is
open (`cors()`), so cross-origin requests are allowed.

## Persistence

The API writes SQLite to `ELIM_DB_PATH` (`/data/elim.db`), which lives on an
attached **Render Disk**. This survives deploys and restarts.

- **Render Disks require a paid instance**, so `elim-erp-api` uses the `starter`
  plan. To stay on the free tier, remove the `disks:` block and revert
  `plan: free` — but then the DB resets on every restart (demo-only).
- For production-grade persistence, point the app at **Supabase Postgres**
  (see `supabase/`) instead of the bundled SQLite.

## Local development

```bash
npm install
npm run dev      # API on :4000, app on :5173 (Vite proxies /api -> :4000)
```

No env vars needed locally; the frontend uses the relative `/api` path.
