import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { KPI, PageHeader } from "@/lib/dashboard-kit";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { usePendingAttention } from "@/lib/pending-attention";
import {
  PAYMENT_CHANNELS,
  UNSPECIFIED_CHANNEL,
  channelLabel,
  dayKey,
  fetchAll,
  sum,
} from "@/lib/metrics";
import {
  cashTxnRows,
  expenseRows,
  paymentRows,
  payrollPaidRows,
  postedSalesRows,
} from "@/lib/metric-queries";
import { exportCsv } from "@/lib/export";
import { CustomerAccountsCard } from "@/components/dashboards/customer-accounts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  FileDown,
  Landmark,
} from "lucide-react";
import { startOfMonth, startOfWeek, startOfYear } from "date-fns";

const PRESETS: { key: string; label: string; from: () => Date }[] = [
  { key: "today", label: "Today", from: () => new Date() },
  { key: "week", label: "This week", from: () => startOfWeek(new Date()) },
  { key: "month", label: "This month", from: () => startOfMonth(new Date()) },
  { key: "year", label: "This year", from: () => startOfYear(new Date()) },
];

const ROW_CAP = 200;

type Txn = {
  key: string;
  date: string;
  direction: "in" | "out";
  channel: string;
  source: string;
  reference: string;
  party: string;
  amount: number;
};

const CASH_CATEGORY_LABEL: Record<string, string> = {
  other_income: "Other income",
  donation_endowment: "Donation / endowment",
  other_inflow: "Other cash inflow",
  other_outflow: "Other cash outflow",
};

// The one financial command center for the factory: cash position for a
// chosen period, broken down by payment channel (cash, transfer, POS, ...),
// what's owed to us, and what's committed to suppliers — with quick links into
// the pages that actually record each of those rather than re-implementing any
// data entry here. Rendered both as the "finance" dashboard variant
// (accountant/payroll_officer land here by default) and as its own /finance
// page reachable by anyone with the `finance` module permission.
export function FinanceOverview({ factoryId }: { factoryId: string }) {
  const [preset, setPreset] = useState("month");
  const [from, setFrom] = useState(() => dayKey(startOfMonth(new Date())));
  const [to, setTo] = useState(() => dayKey(new Date()));
  const [channelFilter, setChannelFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState<"all" | "in" | "out">("all");

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setPreset(p.key);
    setFrom(dayKey(p.from()));
    setTo(dayKey(new Date()));
  };

  useRealtimeInvalidate(
    [
      "sales",
      "payments_received",
      "expenses",
      "payroll",
      "debts",
      "purchase_orders",
      "sales_returns",
      "cash_transactions",
    ],
    [["fin"]],
  );

  const validRange = !!from && !!to && from <= to;

  const revenue = useQuery({
    queryKey: ["fin", "revenue", factoryId, from, to],
    enabled: validRange,
    queryFn: async () =>
      sum(await postedSalesRows(factoryId, "grand_total", from, to), (r) => r.grand_total),
  });

  const payments = useQuery({
    queryKey: ["fin", "payments", factoryId, from, to],
    enabled: validRange,
    queryFn: () => paymentRows(factoryId, from, to),
  });
  const cashTxns = useQuery({
    queryKey: ["fin", "cash-txns", factoryId, from, to],
    enabled: validRange,
    queryFn: () => cashTxnRows(factoryId, from, to),
  });
  const expenses = useQuery({
    queryKey: ["fin", "expenses", factoryId, from, to],
    enabled: validRange,
    queryFn: () => expenseRows(factoryId, from, to),
  });
  const payroll = useQuery({
    queryKey: ["fin", "payroll", factoryId, from, to],
    enabled: validRange,
    queryFn: () => payrollPaidRows(factoryId, from, to),
  });

  const outstandingReceivables = useQuery({
    queryKey: ["fin", "receivables", factoryId],
    queryFn: async () =>
      sum(
        await fetchAll<{ outstanding: number }>(
          (a, b) =>
            supabase
              .from("debts")
              .select("outstanding")
              .eq("factory_id", factoryId)
              .neq("status", "paid")
              .order("id")
              .range(a, b) as any,
        ),
        (r) => r.outstanding,
      ),
  });

  const openPoCommitment = useQuery({
    queryKey: ["fin", "open-po", factoryId],
    queryFn: async () =>
      sum(
        await fetchAll<{ quantity_ordered: number; quantity_received: number; unit_cost: number }>(
          (a, b) =>
            supabase
              .from("purchase_orders")
              .select("quantity_ordered,quantity_received,unit_cost")
              .eq("factory_id", factoryId)
              .in("status", ["issued", "partially_received"])
              .order("id")
              .range(a, b) as any,
        ),
        (r) =>
          (Number(r.quantity_ordered) - Number(r.quantity_received)) * Number(r.unit_cost ?? 0),
      ),
  });

  const pendingReturnsCount = useQuery({
    queryKey: ["fin", "pending-returns", factoryId],
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
    queryKey: ["fin", "recent-returns", factoryId],
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

  const pending = usePendingAttention();

  // Every cash movement in the period as one list, tagged with the channel it
  // moved through — the single source for both the channel totals and the
  // record list below.
  const txns: Txn[] = useMemo(() => {
    const rows: Txn[] = [];
    (payments.data ?? []).forEach((p) =>
      rows.push({
        key: `pay-${p.id}`,
        date: p.payment_date,
        direction: "in",
        channel: p.payment_method,
        source: p.sale_id ? "Sale payment" : "Customer payment",
        reference: p.receipt_number,
        party: p.customers?.name ?? "Walk-in",
        amount: Number(p.amount),
      }),
    );
    (cashTxns.data ?? []).forEach((c) =>
      rows.push({
        key: `cash-${c.id}`,
        date: c.transaction_date,
        direction: c.transaction_type === "receipt" ? "in" : "out",
        channel: c.payment_method,
        source: CASH_CATEGORY_LABEL[c.category] ?? c.category,
        reference: c.transaction_number,
        party: c.payer_payee ?? c.description ?? "—",
        amount: Number(c.amount),
      }),
    );
    (expenses.data ?? []).forEach((e) =>
      rows.push({
        key: `exp-${e.id}`,
        date: e.expense_date,
        direction: "out",
        channel: e.payment_method,
        source: e.expense_categories?.name ?? "Expense",
        reference: e.receipt_number ?? "—",
        party: e.vendor ?? e.description ?? "—",
        amount: Number(e.amount),
      }),
    );
    (payroll.data ?? []).forEach((r) =>
      rows.push({
        key: `pr-${r.id}`,
        date: r.payment_date ?? "",
        direction: "out",
        channel: r.payment_method ?? UNSPECIFIED_CHANNEL,
        source: "Payroll",
        reference: `${String(r.period_month).padStart(2, "0")}/${r.period_year}`,
        party: r.employees?.full_name ?? "—",
        amount: Number(r.net_salary),
      }),
    );
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [payments.data, cashTxns.data, expenses.data, payroll.data]);

  const moneyIn = sum(
    txns.filter((t) => t.direction === "in"),
    (t) => t.amount,
  );
  const moneyOut = sum(
    txns.filter((t) => t.direction === "out"),
    (t) => t.amount,
  );
  const netCashFlow = moneyIn - moneyOut;

  const channelKeys = useMemo(() => {
    const keys: string[] = PAYMENT_CHANNELS.map((c) => c.key);
    if (txns.some((t) => t.channel === UNSPECIFIED_CHANNEL)) keys.push(UNSPECIFIED_CHANNEL);
    return keys;
  }, [txns]);

  const byChannel = useMemo(() => {
    const m: Record<string, { in: number; out: number; count: number }> = {};
    channelKeys.forEach((k) => (m[k] = { in: 0, out: 0, count: 0 }));
    txns.forEach((t) => {
      const row = (m[t.channel] ??= { in: 0, out: 0, count: 0 });
      row[t.direction] += t.amount;
      row.count += 1;
    });
    return m;
  }, [txns, channelKeys]);

  const visible = useMemo(
    () =>
      txns.filter(
        (t) =>
          (channelFilter === "all" || t.channel === channelFilter) &&
          (directionFilter === "all" || t.direction === directionFilter),
      ),
    [txns, channelFilter, directionFilter],
  );
  const visibleIn = sum(
    visible.filter((t) => t.direction === "in"),
    (t) => t.amount,
  );
  const visibleOut = sum(
    visible.filter((t) => t.direction === "out"),
    (t) => t.amount,
  );

  const loading =
    payments.isLoading || cashTxns.isLoading || expenses.isLoading || payroll.isLoading;
  const failed = payments.isError || cashTxns.isError || expenses.isError || payroll.isError;

  const links: { icon: React.ElementType; label: string; to: string }[] = [
    { icon: ShoppingCart, label: "Sales & Invoices", to: "/sales" },
    { icon: Wallet, label: "Cash Ledger", to: "/cash-ledger" },
    { icon: HandCoins, label: "Debts & Receivables", to: "/cash-ledger/debts" },
    { icon: Receipt, label: "Expenses", to: "/expenses" },
    { icon: ClipboardList, label: "Payroll", to: "/payroll" },
    { icon: FileStack, label: "Purchase Orders", to: "/purchase-orders" },
    { icon: Undo2, label: "Sales Returns", to: "/sales-returns" },
  ];

  const exportRecords = () =>
    exportCsv(
      `payment-channels-${from}_to_${to}${channelFilter === "all" ? "" : `-${channelFilter}`}`,
      [
        { key: "date", label: "Date" },
        { key: "direction", label: "In / Out" },
        { key: "channel", label: "Channel" },
        { key: "source", label: "Type" },
        { key: "reference", label: "Reference" },
        { key: "party", label: "Customer / Payee" },
        { key: "amount", label: "Amount" },
      ],
      visible.map((t) => ({
        ...t,
        direction: t.direction === "in" ? "Money in" : "Money out",
        channel: channelLabel(t.channel),
      })),
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        hint="Cash position by period and payment channel, receivables, and commitments — the single view across every finance page."
      />

      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={preset === p.key ? "default" : "outline"}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div>
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => {
                setPreset("custom");
                setFrom(e.target.value);
              }}
            />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={to}
              min={from}
              onChange={(e) => {
                setPreset("custom");
                setTo(e.target.value);
              }}
            />
          </div>
          {!validRange && (
            <p className="text-xs text-destructive">"From" must be on or before "To".</p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KPI
          icon={TrendingUp}
          label="Sales Revenue"
          value={money(revenue.data)}
          hint="Approved invoices in the period"
          tone="success"
        />
        <KPI
          icon={Wallet}
          label="Total In Flow"
          value={money(moneyIn)}
          hint="Payments received + other receipts"
          tone="success"
        />
        <KPI
          icon={TrendingDown}
          label="Total Out Flow"
          value={money(moneyOut)}
          hint="Approved expenses + salaries paid + other payments"
          tone="destructive"
        />
        <KPI
          icon={Landmark}
          label="Net Cash Flow"
          value={money(netCashFlow)}
          hint="In flow minus out flow"
          tone={netCashFlow >= 0 ? "success" : "destructive"}
        />
        <KPI
          icon={ShoppingBag}
          label="Outstanding Receivables"
          value={money(outstandingReceivables.data)}
          hint="Owed to us, unpaid debts (all time)"
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
          value={String(pending.total)}
          hint="Waiting on you"
          tone={pending.total > 0 ? "warning" : "success"}
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
          <CardTitle>Payment channels</CardTitle>
          <p className="text-sm text-muted-foreground">
            Where the money moved — {from} to {to}. Select a channel to see its records.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {failed && (
            <p className="text-sm text-destructive">Could not load some payment records.</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {channelKeys.map((k) => {
              const c = byChannel[k];
              const active = channelFilter === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setChannelFilter(active ? "all" : k)}
                  className={`rounded-xl border p-4 text-left transition-colors hover:bg-muted/40 ${
                    active ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{channelLabel(k)}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.count} record{c.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">In</div>
                      <div className="font-semibold text-success">{money(c.in)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Out</div>
                      <div className="font-semibold text-destructive">{money(c.out)}</div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Net {money(c.in - c.out)}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Label className="text-xs">Channel</Label>
              <Select value={channelFilter} onValueChange={setChannelFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  {channelKeys.map((k) => (
                    <SelectItem key={k} value={k}>
                      {channelLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-40">
              <Label className="text-xs">Direction</Label>
              <Select
                value={directionFilter}
                onValueChange={(v) => setDirectionFilter(v as typeof directionFilter)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">In &amp; out</SelectItem>
                  <SelectItem value="in">Money in</SelectItem>
                  <SelectItem value="out">Money out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto flex items-center gap-4 text-sm">
              <span>
                In <strong className="text-success">{money(visibleIn)}</strong>
              </span>
              <span>
                Out <strong className="text-destructive">{money(visibleOut)}</strong>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={visible.length === 0}
                onClick={exportRecords}
              >
                <FileDown className="h-4 w-4" /> CSV
              </Button>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Customer / Payee</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No records for this selection.
                  </TableCell>
                </TableRow>
              ) : (
                visible.slice(0, ROW_CAP).map((t) => (
                  <TableRow key={t.key}>
                    <TableCell className="whitespace-nowrap">{t.date || "—"}</TableCell>
                    <TableCell>{t.source}</TableCell>
                    <TableCell>{t.reference}</TableCell>
                    <TableCell>{t.party}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{channelLabel(t.channel)}</Badge>
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium ${
                        t.direction === "in" ? "text-success" : "text-destructive"
                      }`}
                    >
                      {t.direction === "in" ? "+" : "−"}
                      {money(t.amount)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {visible.length > ROW_CAP && (
            <p className="text-xs text-muted-foreground">
              Showing the latest {ROW_CAP} of {visible.length} records — totals above cover all of
              them; export CSV for the full list.
            </p>
          )}
        </CardContent>
      </Card>

      <CustomerAccountsCard factoryId={factoryId} />

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
