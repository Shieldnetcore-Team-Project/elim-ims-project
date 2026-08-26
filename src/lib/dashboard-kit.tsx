import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";

// Shared building blocks used by both the role-based dashboard variants
// (_app.dashboard.tsx) and any standalone module page that wants the same
// KPI-card / pending-count widgets (e.g. _app.finance.tsx) — kept in one
// place so neither has to redefine them.

export function KPI({
  icon: Icon,
  label,
  value,
  hint,
  tone = "primary",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  tone?: "primary" | "success" | "warning" | "destructive";
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
            {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
          </div>
          <div className={`grid h-10 w-10 place-items-center rounded-xl ${toneClasses}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PageHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

// Counts pending items across every maker-checker flow — used by any variant
// with an approve/checker-style view of the whole factory.
export function usePendingApprovalsCount(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["pending-approvals-count", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const [exp, debt, payroll, stockRaw, stockFin, roles] = await Promise.all([
        supabase
          .from("expenses")
          .select("id", { count: "exact", head: true })
          .eq("factory_id", factoryId!)
          .eq("status", "pending_approval"),
        supabase
          .from("debts")
          .select("id", { count: "exact", head: true })
          .eq("factory_id", factoryId!)
          .eq("writeoff_status", "pending_approval"),
        supabase
          .from("payroll")
          .select("id", { count: "exact", head: true })
          .eq("factory_id", factoryId!)
          .eq("status", "pending_approval"),
        supabase
          .from("stock_adjustment_requests")
          .select("id", { count: "exact", head: true })
          .eq("factory_id", factoryId!)
          .eq("status", "pending_approval"),
        supabase
          .from("stock_adjustment_requests")
          .select("id", { count: "exact", head: true })
          .eq("factory_id", factoryId!)
          .eq("status", "pending_approval"),
        supabase
          .from("role_grant_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending_approval"),
      ]);
      return (
        (exp.count ?? 0) +
        (debt.count ?? 0) +
        (payroll.count ?? 0) +
        (stockRaw.count ?? 0) +
        (stockFin.count ?? 0) +
        (roles.count ?? 0)
      );
    },
  });
}

export function usePendingConfirmationsCount(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["pending-confirmations-count", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("payments_received")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId!)
        .eq("status", "pending_confirmation");
      if (error) throw error;
      return count ?? 0;
    },
  });
}
