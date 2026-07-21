import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/payroll")({
  head: () => ({ meta: [{ title: "Payroll — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Payroll" description="Monthly payroll runs and payslip generation." phase="Phase 5" />
  ),
});
