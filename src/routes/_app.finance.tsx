import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useFactoryId } from "@/lib/use-factory";
import { FinanceOverview } from "@/components/dashboards/finance-overview";

export const Route = createFileRoute("/_app/finance")({
  head: () => ({ meta: [{ title: "Finance — Elim Table Water" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="finance">
      <FinancePage />
    </RequireAccess>
  ),
});

function FinancePage() {
  const { data: factoryId } = useFactoryId();
  if (!factoryId) return null;
  return <FinanceOverview factoryId={factoryId} />;
}
