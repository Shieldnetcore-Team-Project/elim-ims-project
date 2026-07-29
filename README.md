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
