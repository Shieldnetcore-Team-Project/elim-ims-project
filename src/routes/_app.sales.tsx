import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/sales")({
  head: () => ({ meta: [{ title: "Sales & POS — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Sales & POS" description="Point of sale, invoices, sale history, and receipts." phase="Phase 2" />
  ),
});
