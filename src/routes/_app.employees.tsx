import { createFileRoute } from "@tanstack/react-router";
import { PhasePlaceholder } from "@/components/phase-placeholder";

export const Route = createFileRoute("/_app/employees")({
  head: () => ({ meta: [{ title: "Employees — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <PhasePlaceholder title="Employees" description="Employee records, documents, and compensation profile." phase="Phase 4" />
  ),
});
