import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { DistributorsTab } from "@/components/accounting/distributors-tab";

// Every distributor (registered customer): invoiced, paid, outstanding and
// advance held, with each one's invoices and receipts. The same view as the
// Accountant page's "Distributors" tab, on its own page behind its own module
// (distributor-accounts) so it can be granted without the rest of Accounting.
export const Route = createFileRoute("/_app/distributor-accounts")({
  head: () => ({
    meta: [
      { title: "Distributor Accounts — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Marketer & Retail Accounts" />
      <RequireAccess module="distributor-accounts">
        <DistributorAccountsPage />
      </RequireAccess>
    </>
  ),
});

function DistributorAccountsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  if (!factoryId) return null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Distributor Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Every distributor: what they were invoiced, what they paid, what they still owe and any
          advance they hold.
        </p>
      </div>
      <DistributorsTab factoryId={factoryId} currency={settings.data?.currency ?? "NGN"} />
    </div>
  );
}
