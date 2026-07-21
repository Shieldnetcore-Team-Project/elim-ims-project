import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/production")({
  head: () => ({ meta: [{ title: "Production — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Production" description="Batch runs that increase finished goods inventory." phase="Phase 3" />
  ),
});
