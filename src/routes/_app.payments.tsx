import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/payments")({
  head: () => ({ meta: [{ title: "Payments Received — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Payments Received" description="Receipts and cash-collection tracking." phase="Phase 2" />
  ),
});
