import { createFileRoute, redirect } from "@tanstack/react-router";

// The Approval Center was removed (user, 2026-11-03): each queue is approved
// on its own page (Sales, Expenses, Payroll, Users, ...), and the notification
// bell lists what is waiting. Old links to /approvals land on the Dashboard.
export const Route = createFileRoute("/_app/approvals")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});
