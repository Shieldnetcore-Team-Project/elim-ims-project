import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Banknote, Droplets, PackageCheck, Undo2, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { KPI } from "@/lib/dashboard-kit";
import { money, num } from "@/lib/format";
import type { ReportColumn } from "@/lib/export";
import { ReportActions } from "@/components/shared/report-actions";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Retail dispenser reports (retail_dispenser_report,
// supabase/migrations/20261102300000_retail_dispenser_revenue_remittance.sql):
// every row is a posted record -- a dispenser line on a shop invoice, an
// empty a customer brought back, empties sent to the Warehouse, a day's
// cash-up, a Return-later sale still owing -- so each total on top is the sum
// of the rows below it. Filters: dates, outlet, cashier, customer. Used on
// Retail -> Dispenser Reports and the Accountant page.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
const db = supabase as any;
const n = (v: unknown) => Number(v ?? 0);
const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const monthStart = () => `${lagosToday().slice(0, 8)}01`;
const ALL = "all";

type SaleLine = {
  sale_id: string;
  invoice_number: string;
  sale_date: string;
  created_at: string;
  outlet: string;
  cashier: string;
  customer: string;
  customer_phone: string | null;
  product: string;
  jug: string;
  jar_mode: "return_later" | "permanent" | "swap" | "none";
  quantity: number;
  jugs: number;
  unit_price: number;
  water_revenue: number;
  jar_revenue: number;
  line_total: number;
  is_pr: boolean;
};
type JarReturn = {
  id: string;
  return_number: string;
  recorded_at: string;
  outlet: string;
  invoice_number: string | null;
  customer: string;
  jug: string;
  quantity_good: number;
  quantity_damaged: number;
  quantity_applied: number;
  excess_quantity: number;
  excess_status: string;
  cashier: string;
};
type Transfer = {
  id: string;
  reference: string;
  recorded_at: string;
  outlet: string;
  jug: string;
  sent: number;
  received: number | null;
  status: string;
  short: number | null;
  sent_by: string;
  counted_by: string | null;
  verified_at: string | null;
  verify_note: string | null;
};
type CashUp = {
  outlet: string;
  close_date: string;
  status: "not_submitted" | "submitted" | "queried" | "confirmed";
  reference: string | null;
  sales_value: number;
  water_revenue: number;
  jar_revenue: number;
  adjustments: number;
  expected: number;
  declared: number | null;
  received: number | null;
  short_over: number | null;
  cashier: string | null;
  accountant: string | null;
  reviewed_at: string | null;
  retail_notes: string | null;
  accounts_notes: string | null;
};
type Owed = {
  sale_id: string;
  invoice_number: string;
  sale_date: string;
  outlet: string;
  customer: string;
  customer_phone: string | null;
  jug: string;
  taken: number;
  returned: number;
  outstanding: number;
  days_out: number;
  cashier: string;
};
type Report = {
  sales: SaleLine[];
  returns: JarReturn[];
  transfers: Transfer[];
  cashups: CashUp[];
  outstanding: Owed[];
  cashiers: { id: string; name: string }[];
};

const MODE: Record<SaleLine["jar_mode"], string> = {
  return_later: "Returnable jug",
  permanent: "Jug + Water",
  swap: "Dispenser Water (swap)",
  none: "No choice (older)",
};
const CASHUP: Record<
  CashUp["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  not_submitted: { label: "Not handed in", variant: "outline" },
  submitted: { label: "Awaiting Accounts", variant: "secondary" },
  queried: { label: "Queried", variant: "destructive" },
  confirmed: { label: "Confirmed", variant: "default" },
};
const when = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
const tone = (d: number | null) =>
  d == null || Math.abs(d) < 0.005 ? "" : d < 0 ? "text-destructive font-semibold" : "text-warning";

export function DispenserReports({
  factoryId,
  currency,
  outletId,
}: {
  factoryId: string;
  currency?: string;
  // Fixed by the Retail page's outlet picker; the Accountant page picks here.
  outletId?: string;
}) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(lagosToday());
  const [outlet, setOutlet] = useState(ALL);
  const [cashier, setCashier] = useState(ALL);
  const [customer, setCustomer] = useState("");
  const [tab, setTab] = useState("sales");
  const [mode, setMode] = useState<SaleLine["jar_mode"] | typeof ALL>(ALL);
  const fmt = (v: number) => money(v, currency);
  const theOutlet = outletId ?? (outlet === ALL ? null : outlet);

  useRealtimeInvalidate(
    ["sales", "jar_customer_returns", "jug_returns", "outlet_day_reconciliations"],
    [["dispenser-report"]],
  );
  const outlets = useQuery({
    queryKey: ["outlets", factoryId],
    enabled: !outletId,
    queryFn: async () => {
      const { data, error } = await db
        .from("sales_reps")
        .select("id,full_name,status")
        .eq("factory_id", factoryId)
        .eq("kind", "outlet")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });
  const report = useQuery({
    queryKey: ["dispenser-report", factoryId, from, to, theOutlet, cashier, customer],
    enabled: !!from && !!to && from <= to,
    queryFn: async () => {
      const { data, error } = await db.rpc("retail_dispenser_report", {
        p_factory: factoryId,
        p_from: from,
        p_to: to,
        p_outlet: theOutlet,
        p_cashier: cashier === ALL ? null : cashier,
        p_customer: customer.trim() || null,
      });
      if (error) throw error;
      return data as Report;
    },
  });
  const r = report.data;
  const sales = useMemo(
    () => (r?.sales ?? []).filter((s) => mode === ALL || s.jar_mode === mode),
    [r, mode],
  );
  const all = r?.sales ?? [];
  const sum = <T,>(rows: T[], f: (x: T) => number) => rows.reduce((t, x) => t + f(x), 0);
  const water = sum(all, (s) => n(s.water_revenue));
  const jars = sum(all, (s) => n(s.jar_revenue));
  const units = (m: SaleLine["jar_mode"]) =>
    sum(
      all.filter((s) => s.jar_mode === m),
      (s) => n(s.jugs),
    );
  const owedNow = sum(r?.outstanding ?? [], (o) => n(o.outstanding));
  const shortOver = sum(r?.cashups ?? [], (c) => n(c.short_over));
  const subtitle = [
    `${from} to ${to}`,
    ...(cashier !== ALL
      ? [`Cashier: ${r?.cashiers.find((c) => c.id === cashier)?.name ?? ""}`]
      : []),
    ...(customer.trim() ? [`Customer: ${customer.trim()}`] : []),
  ];
  const go = (t: string, m: SaleLine["jar_mode"] | typeof ALL = ALL) => {
    setTab(t);
    setMode(m);
  };

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">From</div>
            <Input
              type="date"
              className="w-40"
              value={from}
              max={to}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">To</div>
            <Input
              type="date"
              className="w-40"
              value={to}
              min={from}
              max={lagosToday()}
              onChange={(e) => e.target.value && setTo(e.target.value)}
            />
          </div>
          {!outletId && (outlets.data ?? []).length > 1 && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Retail location</div>
              <Select value={outlet} onValueChange={setOutlet}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All shops</SelectItem>
                  {(outlets.data ?? []).map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Cashier</div>
            <Select value={cashier} onValueChange={setCashier}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All cashiers</SelectItem>
                {(r?.cashiers ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Customer</div>
            <Input
              className="w-56"
              placeholder="Name, phone or invoice"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {report.isError && (
        <p className="text-sm text-destructive">{(report.error as Error).message}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <button type="button" className="text-left" onClick={() => go("sales")}>
          <KPI
            icon={Droplets}
            label="Water revenue"
            value={fmt(water)}
            hint={`${num(sum(all, (s) => n(s.jugs)))} dispensers sold`}
          />
        </button>
        <button type="button" className="text-left" onClick={() => go("sales", "permanent")}>
          <KPI
            icon={Banknote}
            label="Jug + Water: jug revenue"
            value={fmt(jars)}
            hint={`${num(units("permanent"))} jug(s) sold for good`}
            tone="success"
          />
        </button>
        <button type="button" className="text-left" onClick={() => go("sales", "return_later")}>
          <KPI
            icon={PackageCheck}
            label="Returnable jug sales"
            value={num(units("return_later"))}
            hint={`Swap ${num(units("swap"))}`}
          />
        </button>
        <button type="button" className="text-left" onClick={() => go("owed")}>
          <KPI
            icon={Users}
            label="Empties owed now"
            value={num(owedNow)}
            tone={owedNow > 0 ? "warning" : "success"}
          />
        </button>
        <button type="button" className="text-left" onClick={() => go("cashups")}>
          <KPI
            icon={Undo2}
            label="Cash-up short / over"
            value={Math.abs(shortOver) < 0.005 ? "—" : fmt(shortOver)}
            hint={`${num((r?.cashups ?? []).filter((c) => c.status === "confirmed").length)} of ${num((r?.cashups ?? []).length)} day(s) confirmed`}
            tone={shortOver < -0.005 ? "destructive" : "primary"}
          />
        </button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="sales">Dispenser sales</TabsTrigger>
          <TabsTrigger value="returns">Empties returned</TabsTrigger>
          <TabsTrigger value="transfers">Empties to Warehouse</TabsTrigger>
          <TabsTrigger value="owed">Outstanding empties</TabsTrigger>
          <TabsTrigger value="cashups">Cashier remittances</TabsTrigger>
        </TabsList>

        <TabsContent value="sales">
          <ReportCard
            title="Dispenser sales"
            note="Each posted dispenser line. Water revenue is the line less its jug part; the jug part is the jug type's jar price, on Jug + Water lines only."
            extra={
              <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                <SelectTrigger className="h-8 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All jar choices</SelectItem>
                  {(Object.keys(MODE) as SaleLine["jar_mode"][]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODE[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
            fileName={`dispenser-sales-${from}-${to}`}
            subtitle={subtitle}
            columns={[
              { key: "date", label: "Date" },
              { key: "invoice", label: "Invoice" },
              { key: "outlet", label: "Shop" },
              { key: "cashier", label: "Cashier" },
              { key: "customer", label: "Customer" },
              { key: "product", label: "Product" },
              { key: "mode", label: "Jar" },
              { key: "qty", label: "Qty" },
              { key: "water", label: "Water" },
              { key: "jar", label: "Jug" },
              { key: "total", label: "Total" },
            ]}
            rows={sales.map((s) => ({
              date: s.sale_date,
              invoice: s.invoice_number + (s.is_pr ? " (PR)" : ""),
              outlet: s.outlet,
              cashier: s.cashier,
              customer: s.customer + (s.customer_phone ? ` ${s.customer_phone}` : ""),
              product: s.product,
              mode: MODE[s.jar_mode],
              qty: num(n(s.quantity)),
              water: fmt(n(s.water_revenue)),
              jar: fmt(n(s.jar_revenue)),
              total: fmt(n(s.line_total)),
            }))}
            totals={{
              qty: num(sum(sales, (s) => n(s.quantity))),
              water: fmt(sum(sales, (s) => n(s.water_revenue))),
              jar: fmt(sum(sales, (s) => n(s.jar_revenue))),
              total: fmt(sum(sales, (s) => n(s.line_total))),
            }}
            loading={report.isLoading}
          />
        </TabsContent>

        <TabsContent value="returns">
          <ReportCard
            title="Empties returned by customers"
            note="Only empties physically received. Applied = settled against what the customer owed; extra empties wait for a manager."
            fileName={`empties-returned-${from}-${to}`}
            subtitle={subtitle}
            columns={[
              { key: "when", label: "When" },
              { key: "ref", label: "Return" },
              { key: "invoice", label: "Sale" },
              { key: "outlet", label: "Shop" },
              { key: "customer", label: "Customer" },
              { key: "jug", label: "Jug" },
              { key: "good", label: "Good" },
              { key: "damaged", label: "Damaged" },
              { key: "applied", label: "Applied" },
              { key: "extra", label: "Extra" },
              { key: "cashier", label: "Received by" },
            ]}
            rows={(r?.returns ?? []).map((x) => ({
              when: when(x.recorded_at),
              ref: x.return_number,
              invoice: x.invoice_number ?? "—",
              outlet: x.outlet,
              customer: x.customer,
              jug: x.jug,
              good: num(n(x.quantity_good)),
              damaged: num(n(x.quantity_damaged)),
              applied: num(n(x.quantity_applied)),
              extra: n(x.excess_quantity)
                ? `${num(n(x.excess_quantity))} (${x.excess_status})`
                : "—",
              cashier: x.cashier,
            }))}
            totals={{
              good: num(sum(r?.returns ?? [], (x) => n(x.quantity_good))),
              damaged: num(sum(r?.returns ?? [], (x) => n(x.quantity_damaged))),
              applied: num(sum(r?.returns ?? [], (x) => n(x.quantity_applied))),
            }}
            loading={report.isLoading}
          />
        </TabsContent>

        <TabsContent value="transfers">
          <ReportCard
            title="Empties sent to the Warehouse"
            note="Off the shop's empties when sent; into the Warehouse when counted. A shortfall is kept on the transfer as recorded and stays on the shop."
            fileName={`empties-to-warehouse-${from}-${to}`}
            subtitle={subtitle}
            columns={[
              { key: "when", label: "Sent" },
              { key: "ref", label: "Reference" },
              { key: "outlet", label: "Shop" },
              { key: "jug", label: "Jug" },
              { key: "sent", label: "Sent" },
              { key: "received", label: "Counted" },
              { key: "short", label: "Short" },
              { key: "status", label: "Status" },
              { key: "by", label: "Sent by" },
              { key: "counted", label: "Counted by" },
            ]}
            rows={(r?.transfers ?? []).map((x) => ({
              when: when(x.recorded_at),
              ref: x.reference,
              outlet: x.outlet,
              jug: x.jug,
              sent: num(n(x.sent)),
              received: x.received == null ? "—" : num(n(x.received)),
              short: x.short == null ? "—" : num(n(x.short)),
              status: x.status === "pending" ? "Awaiting count" : "Counted",
              by: x.sent_by,
              counted: x.counted_by
                ? `${x.counted_by}${x.verify_note ? ` — ${x.verify_note}` : ""}`
                : "—",
            }))}
            totals={{
              sent: num(sum(r?.transfers ?? [], (x) => n(x.sent))),
              received: num(sum(r?.transfers ?? [], (x) => n(x.received))),
              short: num(sum(r?.transfers ?? [], (x) => n(x.short))),
            }}
            loading={report.isLoading}
          />
        </TabsContent>

        <TabsContent value="owed">
          <ReportCard
            title="Outstanding empties (as of now)"
            note="Returnable-jug sales still owing empties, any sale date."
            fileName={`outstanding-empties-${to}`}
            subtitle={subtitle.slice(1)}
            columns={[
              { key: "date", label: "Sale date" },
              { key: "invoice", label: "Invoice" },
              { key: "outlet", label: "Shop" },
              { key: "customer", label: "Customer" },
              { key: "jug", label: "Jug" },
              { key: "taken", label: "Taken" },
              { key: "returned", label: "Returned" },
              { key: "owed", label: "Outstanding" },
              { key: "days", label: "Days" },
              { key: "cashier", label: "Cashier" },
            ]}
            rows={(r?.outstanding ?? []).map((o) => ({
              date: o.sale_date,
              invoice: o.invoice_number,
              outlet: o.outlet,
              customer: o.customer + (o.customer_phone ? ` ${o.customer_phone}` : ""),
              jug: o.jug,
              taken: num(n(o.taken)),
              returned: num(n(o.returned)),
              owed: num(n(o.outstanding)),
              days: num(n(o.days_out)),
              cashier: o.cashier,
            }))}
            totals={{
              taken: num(sum(r?.outstanding ?? [], (o) => n(o.taken))),
              returned: num(sum(r?.outstanding ?? [], (o) => n(o.returned))),
              owed: num(owedNow),
            }}
            loading={report.isLoading}
          />
        </TabsContent>

        <TabsContent value="cashups">
          <ReportCard
            title="Cashier remittances and Accounts confirmation"
            note="Each shop day: what the till should hold, what the cashier handed in, what Accounts received. The revenue split is kept even when the money comes in as one sum."
            fileName={`cashier-remittances-${from}-${to}`}
            subtitle={subtitle}
            columns={[
              { key: "date", label: "Day" },
              { key: "ref", label: "Reference" },
              { key: "outlet", label: "Shop" },
              { key: "water", label: "Water" },
              { key: "jar", label: "Perm. jugs" },
              { key: "adj", label: "Adjust." },
              { key: "sales", label: "Sales" },
              { key: "expected", label: "Expected" },
              { key: "declared", label: "Handed in" },
              { key: "received", label: "Received" },
              { key: "diff", label: "Short/over" },
              { key: "cashier", label: "Cashier" },
              { key: "accountant", label: "Accountant" },
              { key: "status", label: "Status" },
            ]}
            rows={(r?.cashups ?? []).map((c) => ({
              date: c.close_date,
              ref: c.reference ?? "—",
              outlet: c.outlet,
              water: fmt(n(c.water_revenue)),
              jar: fmt(n(c.jar_revenue)),
              adj: fmt(n(c.adjustments)),
              sales: fmt(n(c.sales_value)),
              expected: fmt(n(c.expected)),
              declared: c.declared == null ? "—" : fmt(n(c.declared)),
              received: c.received == null ? "—" : fmt(n(c.received)),
              diff:
                c.short_over == null
                  ? "—"
                  : Math.abs(n(c.short_over)) < 0.005
                    ? "—"
                    : fmt(n(c.short_over)),
              cashier: c.cashier ?? "—",
              accountant: c.accountant ? `${c.accountant}, ${when(c.reviewed_at)}` : "—",
              status: CASHUP[c.status].label,
              _tone: tone(c.short_over),
              _note: [c.retail_notes, c.accounts_notes].filter(Boolean).join(" · "),
            }))}
            totals={{
              water: fmt(sum(r?.cashups ?? [], (c) => n(c.water_revenue))),
              jar: fmt(sum(r?.cashups ?? [], (c) => n(c.jar_revenue))),
              adj: fmt(sum(r?.cashups ?? [], (c) => n(c.adjustments))),
              sales: fmt(sum(r?.cashups ?? [], (c) => n(c.sales_value))),
              expected: fmt(sum(r?.cashups ?? [], (c) => n(c.expected))),
              declared: fmt(sum(r?.cashups ?? [], (c) => n(c.declared))),
              received: fmt(sum(r?.cashups ?? [], (c) => n(c.received))),
              diff: fmt(shortOver),
            }}
            loading={report.isLoading}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// One report: the table on screen and the same rows to Print / Excel / CSV.
// A row's _tone colours it (short / over) and _note shows under it.
function ReportCard({
  title,
  note,
  extra,
  columns,
  rows,
  totals,
  fileName,
  subtitle,
  loading,
}: {
  title: string;
  note: string;
  extra?: React.ReactNode;
  columns: ReportColumn[];
  rows: Record<string, string>[];
  totals: Record<string, string>;
  fileName: string;
  subtitle: string[];
  loading: boolean;
}) {
  const exportRows = rows.map((r) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_"))),
  );
  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{note}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {extra}
          <ReportActions
            size="sm"
            title={title}
            fileName={fileName}
            columns={columns}
            rows={[
              ...exportRows,
              ...(rows.length ? [{ [columns[0].key]: "Total", ...totals }] : []),
            ]}
            subtitle={subtitle}
          />
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.key} className="whitespace-nowrap">
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} className={r._tone ?? ""}>
                {columns.map((c, j) => (
                  <TableCell key={c.key} className="whitespace-nowrap text-sm">
                    {r[c.key]}
                    {j === 0 && r._note && (
                      <div className="max-w-xs whitespace-normal text-[11px] text-muted-foreground">
                        {r._note}
                      </div>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-6 text-center text-muted-foreground"
                >
                  {loading ? "Loading…" : "Nothing in this period."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {rows.length > 0 && (
            <TableFooter>
              <TableRow>
                {columns.map((c, j) => (
                  <TableCell key={c.key} className="whitespace-nowrap font-semibold">
                    {j === 0 ? "Total" : (totals[c.key] ?? "")}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}
