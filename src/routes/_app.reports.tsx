import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/reports")({
  head: () => ({ meta: [{ title: "Reports — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Reports" description="Cross-module reports with Excel, PDF, and CSV export." phase="Phase 6" />
  ),
});
