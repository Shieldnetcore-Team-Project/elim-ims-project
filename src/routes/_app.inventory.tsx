import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/inventory")({
  head: () => ({ meta: [{ title: "Inventory — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Inventory" description="Full inventory movements and stock history." phase="Phase 3" />
  ),
});
