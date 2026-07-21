import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/raw-materials")({
  head: () => ({ meta: [{ title: "Raw Materials — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Raw Materials" description="Stock, purchases, issues to production, and reorder alerts." phase="Phase 3" />
  ),
});
