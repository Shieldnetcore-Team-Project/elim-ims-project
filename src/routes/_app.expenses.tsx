import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/expenses")({
  head: () => ({ meta: [{ title: "Expenses — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Expenses" description="Recorded business expenses with receipts and approvals." phase="Phase 4" />
  ),
});
