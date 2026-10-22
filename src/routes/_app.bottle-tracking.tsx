import { createFileRoute, redirect } from "@tanstack/react-router";

// Bottle tracking moved from the Warehouse to the Quality Control page (the
// Warehouse keeps track of finished products only) -- keep this route as a
// redirect so old links and bookmarks still land on it.
export const Route = createFileRoute("/_app/bottle-tracking")({
  beforeLoad: () => {
    throw redirect({ to: "/quality-control", search: { tab: "bottle-tracking" } });
  },
});
