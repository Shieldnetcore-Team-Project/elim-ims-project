import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { KPI, PageHeader, usePendingApprovalsCount } from "@/lib/dashboard-kit";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/format";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  HandCoins,
  ShoppingBag,
  CheckSquare,
  FileStack,
  ShoppingCart,
  Receipt,
  ClipboardList,
  ArrowRight,
  Undo2,
} from "lucide-react";
import { startOfMonth } from "date-fns";

// The one financial command center for the factory: cash position, what's
// owed to us, what's committed to suppliers, and this month's cost lines —
// with quick links into the pages that actually record each of those
// (Sales, Cash Ledger, Expenses, Payroll, Purchase Orders, Reports) rather
// than re-implementing any of their data entry here. Rendered both as the
// "finance" dashboard variant (accountant/payroll_officer land here by
// default) and as its own /finance page reachable by anyone with the
// `finance` module permission — one component, not two.
export function FinanceOverview({ factoryId }: { factoryId: string }) {
  const monthStart = startOfMonth(new Date()).toISOString();
  const monthStartDate = startOfMonth(new Date());
  const periodMonth = monthStartDate.getMonth() + 1;
  const periodYear = monthStartDate.getFullYear();
  useRealtimeInvalidate(
    [
      "sales",
      "payments_received",
      "expenses",
      "payroll",
      "debts",
      "purchase_orders",
      "sales_returns",
      "stock_adjustment_requests",
      "role_grant_requests",
    ],
    [
      ["fin-revenue-month"],
      ["fin-collections-month"],
      ["fin-expenses-month"],
      ["fin-payroll-month"],
      ["fin-outstanding-receivables"],
      ["fin-open-po-commitment"],
      ["fin-recent-payments"],
      ["fin-pending-returns"],
      ["fin-recent-returns"],
      ["pending-approvals-count"],
    ],
  );

  const revenue = useQuery({
    queryKey: ["fin-revenue-month", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("grand_total")
        .eq("factory_id", factoryId)
        .gte("created_at", monthStart);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.grand_total ?? 0), 0);
    },
  });

  const collectionsMonth = useQuery({
    queryKey: ["fin-collections-month", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("amount")
        .eq("factory_id", factoryId)
        .gte("created_at", monthStart);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    },
  });

  const expensesMonth = useQuery({
    queryKey: ["fin-expenses-month", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select("amount")
        .eq("factory_id", factoryId)
        .eq("approval_status", "approved")
        .gte("expense_date", monthStart);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    },
  });

  const payrollMonth = useQuery({
    queryKey: ["fin-payroll-month", factoryId, periodMonth, periodYear],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll")
        .select("net_salary")
        .eq("factory_id", factoryId)
        .eq("period_month", periodMonth)
        .eq("period_year", periodYear);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.net_salary ?? 0), 0);
    },
  });

  const outstandingReceivables = useQuery({
    queryKey: ["fin-outstanding-receivables", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debts")
        .select("outstanding")
        .eq("factory_id", factoryId)
        .neq("status", "paid");
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
    },
  });

  const openPoCommitment = useQuery({
    queryKey: ["fin-open-po-commitment", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("quantity_ordered,quantity_received,unit_cost")
        .eq("factory_id", factoryId)
        .in("status", ["issued", "partially_received"]);
      if (error) throw error;
      return (data ?? []).reduce(
        (s, r) =>
          s + (Number(r.quantity_ordered) - Number(r.quantity_received)) * Number(r.unit_cost ?? 0),
        0,
      );
    },
  });

  const recentPayments = useQuery({
    queryKey: ["fin-recent-payments", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,amount,payment_date,customers(name)")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data ?? [];
    },
  });

  const pendingReturnsCount = useQuery({
    queryKey: ["fin-pending-returns", factoryId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("sales_returns")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId)
        .eq("status", "received");
      if (error) throw error;
      return count ?? 0;
    },
  });

  const recentReturns = useQuery({
    queryKey: ["fin-recent-returns", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_returns")
        .select(
          "id,return_number,quantity_returned,accepted_quantity,damaged_quantity,rejected_quantity,status,received_at,products(name),customers(name)",
        )
        .eq("factory_id", factoryId)
        .order("received_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data ?? [];
    },
  });

  const pendingApprovals = usePendingApprovalsCount(factoryId);

  const cashOutMonth = (expensesMonth.data ?? 0) + (payrollMonth.data ?? 0);
  const netCashFlow = (collectionsMonth.data ?? 0) - cashOutMonth;

  const links: { icon: React.ElementType; label: string; to: string }[] = [
    { icon: ShoppingCart, label: "Sales & Invoices", to: "/sales" },
    { icon: Wallet, label: "Cash Ledger", to: "/cash-ledger" },
    { icon: HandCoins, label: "Debts & Receivables", to: "/cash-ledger/debts" },
    { icon: Receipt, label: "Expenses", to: "/expenses" },
    { icon: ClipboardList, label: "Payroll", to: "/payroll" },
    { icon: FileStack, label: "Purchase Orders", to: "/purchase-orders" },
    { icon: Undo2, label: "Sales Returns", to: "/sales-returns" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        hint="Cash position, receivables, and this month's cost lines — the single view across every finance page."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <KPI
          icon={TrendingUp}
          label="Revenue (this month)"
          value={money(revenue.data)}
          tone="success"
        />
        <KPI
          icon={TrendingDown}
          label="Total Out Flow (this month)"
          value={money(cashOutMonth)}
          hint="Expenses + payroll"
          tone="destructive"
        />
        <KPI
          icon={Wallet}
          label="Total In Flow (this month)"
          value={money(netCashFlow)}
          tone={netCashFlow >= 0 ? "success" : "destructive"}
        />
        <KPI
          icon={ShoppingBag}
          label="Outstanding Receivables"
          value={money(outstandingReceivables.data)}
          hint="Owed to us, unpaid debts"
          tone="warning"
        />
        <KPI
          icon={FileStack}
          label="Open Purchase Commitments"
          value={money(openPoCommitment.data)}
          hint="Issued POs still awaiting delivery"
        />
        <KPI
          icon={CheckSquare}
          label="Pending Approvals"
          value={String(pendingApprovals.data ?? 0)}
          tone={(pendingApprovals.data ?? 0) > 0 ? "warning" : "success"}
        />
        <KPI
          icon={Undo2}
          label="Returns Awaiting Inspection"
          value={String(pendingReturnsCount.data ?? 0)}
          tone={(pendingReturnsCount.data ?? 0) > 0 ? "warning" : "success"}
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Go to</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {links.map((l) => (
            <Button
              key={l.to}
              variant="outline"
              className="h-auto justify-start gap-2 py-3"
              asChild
            >
              <Link to={l.to}>
                <l.icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left">{l.label}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </Link>
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Recent payments</CardTitle>
        </CardHeader>
        <CardContent>
          {(recentPayments.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
          ) : (
            <ul className="divide-y">
              {recentPayments.data!.map((p: any) => (
                <li key={p.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <div className="font-medium">{p.receipt_number}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.customers?.name ?? "—"} · {p.payment_date}
                    </div>
                  </div>
                  <div>{money(Number(p.amount))}</div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Recent sales returns</CardTitle>
        </CardHeader>
        <CardContent>
          {(recentReturns.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No sales returns logged yet.</p>
          ) : (
            <ul className="divide-y">
              {recentReturns.data!.map((r: any) => (
                <li key={r.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <div className="font-medium">
                      {r.return_number} · {r.products?.name ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.customers?.name ?? "—"} · returned {r.quantity_returned}
                      {r.status === "completed"
                        ? ` (accepted ${r.accepted_quantity ?? 0}, damaged ${r.damaged_quantity}, rejected ${r.rejected_quantity})`
                        : " — awaiting inspection"}
                    </div>
                  </div>
                  <span className="text-xs uppercase text-muted-foreground">{r.status}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
