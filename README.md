# Elim Water Factory — ERP

A React/TypeScript ERP frontend with a lightweight Express API, built out from
`elim-erp-dashboard-preview.html` (kept for reference) and
`ELIM-ERP-DESIGN-SYSTEM.md`.

```
shared/   TypeScript types + the config for all 18 modules (single source of truth)
server/   Express API, in-memory seeded mock data
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
