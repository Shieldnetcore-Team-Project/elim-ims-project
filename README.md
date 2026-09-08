# Elim Water Factory — ERP

A React/TypeScript ERP frontend with a lightweight Express API, built out from
`elim-erp-dashboard-preview.html` (kept for reference) and
`ELIM-ERP-DESIGN-SYSTEM.md`.

```
shared/   TypeScript types + the module config (single source of truth)
server/   Express API backed by Postgres (Supabase in prod); opt-in demo seed
client/   Vite + React + TypeScript frontend
```

## Run it

```
npm install
npm run dev
```

This starts the API on [http://localhost:4000](http://localhost:4000) and the
app on [http://localhost:5173](http://localhost:5173) (Vite proxies `/api` to
the server, so just open the client URL).

## Build

```
npm run build
```

## Test

The server test suite runs against a real Postgres in Docker (matches
production; no SQLite dialect drift).

```
npm test                     # from repo root — starts the test DB, then runs vitest
```

`npm test` runs a `pretest` hook that does `docker compose up -d --wait test-db`
(see [`docker-compose.yml`](docker-compose.yml) — Postgres 16 on host port 5433,
data in tmpfs so every run starts clean). Requires **Docker Desktop** running.

```
npm run test:db:up   -w server   # start the test DB by hand
npm run test:db:down -w server   # stop it
```

To point the suite at a different Postgres, set `DATABASE_URL` — it must be a
local/disposable instance, since `vitest.globalSetup.ts` drops and recreates the
`public` schema on every run (and refuses to run against a non-local host).

## Deploy (Render, static frontend)

The client is a Vite app that builds to **`client/dist`** (not repo-root
`dist`). Configure the Render Static Site as follows:

- **Build Command:** `npm install && npm run build -w client`
- **Publish Directory:** `dist` (Vite is configured to output to the repo-root `dist`)
- **Root Directory:** repo root

A `render.yaml` with these settings is included — connect the repo in Render
and it will be picked up automatically. The chunk-size warning during build is
advisory only and does not block deploys.
# Elim-ims-project
