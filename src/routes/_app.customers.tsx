import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/customers")({
  head: () => ({ meta: [{ title: "Customers — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Customers" description="Customer profiles, purchase history, and outstanding balances." phase="Phase 2" />
  ),
});
