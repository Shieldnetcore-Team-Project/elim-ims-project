import { createFileRoute, Link } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { AlarmClock, CircleDollarSign, Clock, Search, Wallet } from "lucide-react";

// Credit sales: every approved sale that wasn't fully paid becomes a debt
// (approve_sale). This lists them with their terms -- due date from the
// customer's payment terms, the customer's credit limit, and the recovery
// date once cleared (20260928120000_customer_credit_terms.sql). Payments are
// still recorded from Payments -> Debts; this page is the credit view of them.
export const Route = createFileRoute("/_app/credit-sales")({
  head: () => ({
    meta: [{ title: "Credit Sales — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="debts">
        <CreditSalesPage />
      </RequireAccess>
    </>
  ),
});

type CreditRow = {
  id: string;
  total_amount: number;
  amount_paid: number;
  outstanding: number;
  status: "paid" | "partial" | "unpaid";
  created_at: string;
  due_date: string | null;
  paid_at: string | null;
  writeoff_status: string | null;
  customers: { name: string; credit_limit: number | null; outstanding_balance: number } | null;
  sales: { invoice_number: string; sale_date: string } | null;
  sales_reps: { full_name: string } | null;
};

type Status = "paid" | "partial" | "unpaid" | "overdue" | "written_off";

const todayIso = () => new Date().toISOString().slice(0, 10);

function statusOf(r: CreditRow): Status {
  if (r.writeoff_status === "posted") return "written_off";
  if (r.status === "paid") return "paid";
  if (r.due_date && r.due_date < todayIso()) return "overdue";
  return r.status;
}

const STATUS: Record<Status, { label: string; variant: "secondary" | "outline" | "destructive" }> =
  {
    unpaid: { label: "Credit", variant: "outline" },
    partial: { label: "Partially paid", variant: "outline" },
    overdue: { label: "Overdue", variant: "destructive" },
    paid: { label: "Recovered", variant: "secondary" },
    written_off: { label: "Written off", variant: "secondary" },
  };

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "—");

function daysOverdue(due: string | null) {
  if (!due) return 0;
  const ms = new Date(todayIso()).getTime() - new Date(due).getTime();
  return Math.max(Math.floor(ms / 86400000), 0);
}

function CreditSalesPage() {
  const { data: factoryId } = useFactoryId();
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | Status>("open");
  const [q, setQ] = useState("");

  useRealtimeInvalidate(["debts", "payments_received"], [["credit-sales"]]);

  const list = useQuery({
    queryKey: ["credit-sales", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debts")
        .select(
          "id,total_amount,amount_paid,outstanding,status,created_at,due_date,paid_at,writeoff_status,customers(name,credit_limit,outstanding_balance),sales(invoice_number,sale_date),sales_reps(full_name)",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as CreditRow[];
    },
  });

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const open = rows.filter((r) => r.status !== "paid");
  const kpi = {
    credit: open.length,
    partial: open.filter((r) => r.status === "partial").length,
    overdue: open.filter((r) => statusOf(r) === "overdue").length,
    outstanding: open.reduce((s, r) => s + Number(r.outstanding), 0),
    overdueValue: open
      .filter((r) => statusOf(r) === "overdue")
      .reduce((s, r) => s + Number(r.outstanding), 0),
  };

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      const s = statusOf(r);
      if (statusFilter === "open" && (s === "paid" || s === "written_off")) return false;
      if (statusFilter !== "all" && statusFilter !== "open" && s !== statusFilter) return false;
      if (!term) return true;
      return (
        (r.sales?.invoice_number ?? "").toLowerCase().includes(term) ||
        (r.customers?.name ?? "").toLowerCase().includes(term) ||
        (r.sales_reps?.full_name ?? "").toLowerCase().includes(term)
      );
    });
  }, [rows, statusFilter, q]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Credit Sales</h1>
        <p className="text-sm text-muted-foreground">
          Sales not fully paid at approval, with their due dates, credit limits and recovery. Record
          collections from{" "}
          <Link to="/cash-ledger/debts" className="text-primary hover:underline">
            Payments → Debts
          </Link>
          ; set limits and payment terms on{" "}
          <Link
            to="/customers"
            state={{ section: "Warehouse" }}
            className="text-primary hover:underline"
          >
            Customers
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={Wallet} label="Open credit sales" value={String(kpi.credit)} />
        <Kpi icon={Clock} label="Partially paid" value={String(kpi.partial)} />
        <Kpi
          icon={AlarmClock}
          label="Overdue"
          value={String(kpi.overdue)}
          sub={kpi.overdue > 0 ? money(kpi.overdueValue) : undefined}
          danger={kpi.overdue > 0}
        />
        <Kpi icon={CircleDollarSign} label="Total outstanding" value={money(kpi.outstanding)} />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Credit sales</CardTitle>
            <p className="text-sm text-muted-foreground">
              {filtered.length} of {rows.length} credit sale(s) shown.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="w-56 pl-8"
                placeholder="Invoice, customer, marketer…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="unpaid">Unpaid</SelectItem>
                <SelectItem value="partial">Partially paid</SelectItem>
                <SelectItem value="paid">Recovered</SelectItem>
                <SelectItem value="written_off">Written off</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Credit date</TableHead>
                <TableHead>Due date</TableHead>
                <TableHead className="text-right">Credit limit</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Recovery date</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">
                    {list.isLoading
                      ? "Loading…"
                      : "No credit sales. They appear here when an approved sale isn't fully paid."}
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((r) => {
                const s = statusOf(r);
                const limit = r.customers?.credit_limit;
                const overLimit =
                  limit != null && Number(r.customers?.outstanding_balance ?? 0) > Number(limit);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      {r.sales?.invoice_number ?? "Adjustment"}
                    </TableCell>
                    <TableCell>{r.customers?.name ?? "Walk-in"}</TableCell>
                    <TableCell>{r.sales_reps?.full_name ?? "—"}</TableCell>
                    <TableCell className="text-right">{money(Number(r.total_amount))}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {fmtDate(r.sales?.sale_date ?? r.created_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {fmtDate(r.due_date)}
                      {s === "overdue" && (
                        <div className="text-xs text-destructive">
                          {daysOverdue(r.due_date)} day(s) late
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {limit == null ? (
                        <span className="text-muted-foreground">No limit</span>
                      ) : (
                        <span className={overLimit ? "text-destructive" : ""}>
                          {money(Number(limit))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(r.amount_paid))}</TableCell>
                    <TableCell className="text-right font-medium">
                      {money(Number(r.outstanding))}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{fmtDate(r.paid_at)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS[s].variant}>{STATUS[s].label}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  danger,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  sub?: string;
  danger?: boolean;
}) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <Icon className={`h-4 w-4 ${danger ? "text-destructive" : "text-primary"}`} />
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${danger ? "text-destructive" : ""}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub} overdue</div>}
      </CardContent>
    </Card>
  );
}
