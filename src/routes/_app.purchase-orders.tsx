import { createFileRoute, redirect } from "@tanstack/react-router";

// Purchase Orders was folded into the merged Procurement page (Purchase
// Requests + Purchase Orders together) — keep this route around as a
// redirect so old links/bookmarks still land somewhere useful.
export const Route = createFileRoute("/_app/purchase-orders")({
  beforeLoad: () => {
    throw redirect({ to: "/procurement" });
  },
});
