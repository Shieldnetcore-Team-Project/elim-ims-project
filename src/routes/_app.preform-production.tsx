import { createFileRoute, redirect } from "@tanstack/react-router";

// Preform blowing is run from Quality Control → Good bottles: QC accepts the
// preforms the Store issues, records each shift, stocks the good bottles and
// sends them to production; the managers' Exceptions, Reports and Setup moved
// there too. The Store issues preforms from Store → Preform Inventory. Kept
// as a redirect so old links and bookmarks still land somewhere useful.
export const Route = createFileRoute("/_app/preform-production")({
  beforeLoad: ({ search }) => {
    if ((search as { tab?: string }).tab === "issues") {
      throw redirect({ to: "/preform-inventory", search: { tab: "issues" } });
    }
    throw redirect({ to: "/quality-control", search: { tab: "good-bottles" } });
  },
});
