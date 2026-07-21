import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/debts")({
  head: () => ({ meta: [{ title: "Debt Management — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Debt Management" description="Track outstanding debts and record repayments." phase="Phase 2" />
  ),
});
