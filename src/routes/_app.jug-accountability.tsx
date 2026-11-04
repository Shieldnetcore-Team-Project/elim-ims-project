import { createFileRoute, redirect } from "@tanstack/react-router";

// Dispenser & jugs moved to Quality Control (user, 2026-11-04): the page is
// src/components/jugs/jug-accountability-page.tsx, a tab of /quality-control.
// This address stays so old links and bookmarks still land on it.
export const Route = createFileRoute("/_app/jug-accountability")({
  beforeLoad: () => {
    throw redirect({ to: "/quality-control", search: { tab: "dispenser-jugs" } });
  },
});
