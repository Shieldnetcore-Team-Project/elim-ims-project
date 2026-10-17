import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { AccountsTab, type Rep } from "@/routes/_app.distribution";

// Each marketer's and the Company Retail Shop's account -- goods posted to
// them, returns, cash remitted and what they owe. The same view as the
// Accountant page's "Marketer & retail accounts" tab, on its own page behind
// its own module (marketer-accounts) so it can be granted without the rest
// of Accounting.
export const Route = createFileRoute("/_app/marketer-accounts")({
  head: () => ({
    meta: [
      { title: "Marketer & Retail Accounts — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Marketer & Retail Accounts" />
      <RequireAccess module="marketer-accounts">
        <MarketerAccountsPage />
      </RequireAccess>
    </>
  ),
});

function MarketerAccountsPage() {
  const { data: factoryId } = useFactoryId();
  const perms = usePermissions();
  const reps = useQuery({
    queryKey: ["dist-reps", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,code,full_name,phone,status,employee_id,remarks,kind")
        .eq("factory_id", factoryId!)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Rep[];
    },
  });

  if (!factoryId) return null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Marketer &amp; Retail Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Pick a marketer or the retail shop to see what was posted to them, what they returned, the
          cash they remitted and what they still owe.
        </p>
      </div>
      <AccountsTab factoryId={factoryId} reps={reps.data ?? []} perms={perms} />
    </div>
  );
}
