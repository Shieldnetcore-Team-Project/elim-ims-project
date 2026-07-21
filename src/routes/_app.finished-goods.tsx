import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/finished-goods")({
  head: () => ({ meta: [{ title: "Finished Goods — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Finished Goods" description="Available stock, transfers, returns, and damages." phase="Phase 3" />
  ),
});
