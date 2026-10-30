import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { printRollReport } from "@/lib/roll-receipt-print";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { KPI } from "@/lib/dashboard-kit";
import { money, num } from "@/lib/format";
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
import { Banknote, CreditCard, RotateCcw, TrendingUp } from "lucide-react";
import { PrintCopiesButton } from "@/components/shared/print-copies-button";

export const Route = createFileRoute("/_app/retail-summary")({
  head: () => ({
    meta: [
      { title: "Retail Transaction Summary — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { tab?: string } => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  component: () => (
    <>
      <SectionTabs section="Retail" />
      <RequireAccess module="sales">
        <RetailSummaryPage />
      </RequireAccess>
    </>
  ),
});

// The shop's day at a glance, as the till's "Transaction Summary" printout:
//   Transaction Summary  per product opening / in / out / returned / sold /
//                        in stock and sales value, plus the money by payment
//                        method -- the same figures the day close sends to
//                        Accounts (outlet_day_figures, see
//                        supabase/migrations/20261029290000_retail_customer_returns.sql).
//   Posting Log (?tab=log)  every posting on the shop's stock that day
//                        (Warehouse postings, sales, returns, reversals): who
//                        posted it and at what time.
// Both read only; nothing here moves stock.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
const db = supabase as any;

const n = (v: unknown) => Number(v ?? 0);
// Roll prints write amounts as the Warehouse receipt does: no ₦ sign.
const amt = (v: number) => Math.round(v).toLocaleString("en-US");
const naira = (v: number) => `N${amt(v)}`;

// Posting log: stands in for postings with no user (system-made).
const SYSTEM = "__system";

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

// Lagos is UTC+1 all year: the day's bounds as instants.
const dayBounds = (d: string) => {
  const start = new Date(`${d}T00:00:00+01:00`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  transfer: "Bank transfer",
  bank_transfer: "Bank transfer",
  pos: "POS / Card",
  card: "Card",
  cheque: "Cheque",
  credit: "Credit",
  mobile_money: "Mobile money",
};
const methodLabel = (m: string) =>
  METHOD_LABEL[m] ?? m.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

type Outlet = { id: string; full_name: string; status: string };

type ProductFig = {
  product_id: string;
  name: string;
  unit: string;
  opening: number;
  received: number;
  sold: number;
  returned: number;
  damaged: number;
  corrections: number;
  closing: number;
  sold_value: number;
};

type DayFigures = {
  products: ProductFig[];
  money: {
    sales_count: number;
    sales_value: number;
    advance_applied: number;
    cash_expected: number;
    other_expected: number;
    credit_sales: number;
    refunds_cash?: number;
    refunds_other?: number;
    by_method: Record<string, number>;
  };
  pending_sales: number;
};

type Movement = {
  id: string;
  created_at: string;
  movement_type: string;
  quantity: number;
  reference: string | null;
  reason: string | null;
  user_id: string | null;
  products: { name: string; unit: string } | null;
};

type SaleInfo = {
  invoice_number: string;
  grand_total: number;
  payment_method: string;
  customer_name: string | null;
  status: string;
};

function RetailSummaryPage() {
  const { data: factoryId } = useFactoryId();
  const { tab } = Route.useSearch();
  const [outletId, setOutletId] = useState("");
  const [date, setDate] = useState(lagosToday());

  useRealtimeInvalidate(
    ["sales", "rep_stock_movements", "payments_received", "sales_returns"],
    [["retail-summary"], ["retail-log"]],
  );

  const outlets = useQuery({
    queryKey: ["outlets", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,status")
        .eq("factory_id", factoryId!)
        .eq("kind", "outlet")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Outlet[];
    },
  });

  useEffect(() => {
    if (outletId || !outlets.data?.length) return;
    setOutletId((outlets.data.find((o) => o.status === "active") ?? outlets.data[0]).id);
  }, [outlets.data, outletId]);

  if (!factoryId) return null;
  const isLog = tab === "log";
  const outletName = outlets.data?.find((o) => o.id === outletId)?.full_name ?? "Retail Shop";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isLog ? "Posting Log" : "Transaction Summary"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isLog
              ? "Everything posted on the shop's stock for the day: who posted it and at what time."
              : "The shop's day: stock in and out per product, sales, and money by payment method."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(outlets.data ?? []).length > 1 && (
            <Select value={outletId} onValueChange={setOutletId}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Outlet" />
              </SelectTrigger>
              <SelectContent>
                {(outlets.data ?? []).map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            type="date"
            className="w-40"
            value={date}
            max={lagosToday()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
      </div>

      {outlets.isSuccess && outlets.data.length === 0 ? (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No retail outlet set up yet.
          </CardContent>
        </Card>
      ) : !outletId ? null : isLog ? (
        <PostingLog outletId={outletId} outletName={outletName} date={date} />
      ) : (
        <TransactionSummary outletId={outletId} outletName={outletName} date={date} />
      )}
    </div>
  );
}

// The roll print's header (as the Warehouse receipt) and who is printing.
function usePrintHeader() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId).data;
  const me = useCurrentUserName().data;
  return {
    company: {
      name: settings?.company_name ?? "Elim Table Water",
      address: settings?.address,
      phone: settings?.phone,
      logo_url: settings?.logo_url,
    },
    printedBy: me,
  };
}

type PanelProps = { outletId: string; outletName: string; date: string };

function TransactionSummary({ outletId, outletName, date }: PanelProps) {
  const { company, printedBy } = usePrintHeader();
  const day = useQuery({
    queryKey: ["retail-summary", outletId, date],
    queryFn: async () => {
      const { data, error } = await db.rpc("outlet_day_figures", {
        p_outlet: outletId,
        p_date: date,
      });
      if (error) throw error;
      return (data as { live: DayFigures }).live;
    },
  });

  // Qty Out: everything that left the shelf (sold, sent back to the
  // Warehouse, damaged). Qty Ret.: what came back onto it -- customer
  // returns and cancelled sales, less any reversed Warehouse posting.
  // Opening + Qty In - Qty Out + Qty Ret. = In Stock.
  const rows = useMemo(
    () =>
      (day.data?.products ?? []).map((p) => {
        const opening = n(p.opening);
        const received = n(p.received);
        return {
          id: p.product_id,
          name: p.name,
          unit: p.unit,
          opening,
          received,
          total: opening + received,
          out: n(p.sold) + n(p.returned) + n(p.damaged),
          ret: n(p.corrections),
          sold: n(p.sold),
          closing: n(p.closing),
          value: n(p.sold_value),
        };
      }),
    [day.data],
  );
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((t, r) => t + Number(r[k]), 0);

  const m = day.data?.money;
  const salesValue = n(m?.sales_value);
  const refunds = n(m?.refunds_cash) + n(m?.refunds_other);
  // cash/other_expected already have the day's refunds taken off.
  const collected = n(m?.cash_expected) + n(m?.other_expected) + refunds;
  const methods = Object.entries(m?.by_method ?? {})
    .map(([k, v]) => ({ method: k, amount: n(v) }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
  const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  if (day.isError)
    return (
      <Card className="rounded-2xl border-destructive/40">
        <CardContent className="py-6 text-sm text-destructive">
          {(day.error as Error).message}
        </CardContent>
      </Card>
    );

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPI
          icon={TrendingUp}
          label="Total Sales"
          value={money(salesValue)}
          hint={`${num(n(m?.sales_count))} sale(s) on ${dayLabel}`}
          tone="success"
        />
        <KPI
          icon={Banknote}
          label="Collected"
          value={money(collected)}
          hint="Paid at the till, all methods"
        />
        <KPI
          icon={CreditCard}
          label="On Credit"
          value={money(n(m?.credit_sales))}
          hint={
            n(m?.advance_applied) > 0
              ? `${money(n(m?.advance_applied))} taken from customer advances`
              : "Not yet paid"
          }
          tone={n(m?.credit_sales) > 0 ? "warning" : "primary"}
        />
        <KPI
          icon={RotateCcw}
          label="Refunds"
          value={money(refunds)}
          hint="Handed back for returned goods"
          tone={refunds > 0 ? "destructive" : "primary"}
        />
      </div>

      {n(day.data?.pending_sales) > 0 && (
        <p className="text-sm text-warning">
          {num(n(day.data?.pending_sales))} sale(s) on this day are still waiting for approval and
          are not counted yet.
        </p>
      )}

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle>Payment Methods Summary</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payment method</TableHead>
                <TableHead className="text-right">Total sales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {methods.map((r) => (
                <TableRow key={r.method}>
                  <TableCell className="font-medium">{methodLabel(r.method)}</TableCell>
                  <TableCell className="text-right">{money(r.amount)}</TableCell>
                </TableRow>
              ))}
              {methods.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="py-6 text-center text-muted-foreground">
                    {day.isLoading ? "Loading…" : "No payments taken on this day."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {methods.length > 1 && (
              <TableFooter>
                <TableRow>
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right">
                    {money(methods.reduce((t, r) => t + r.amount, 0))}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Product Sales Summary</CardTitle>
            <p className="text-sm text-muted-foreground">
              Opening + Qty In − Qty Out + Qty Ret. = In Stock.
            </p>
          </div>
          <PrintCopiesButton
            title="Print transaction summary"
            onPrint={(copies) =>
              printRollReport(
                {
                  company,
                  title: "TRANSACTION SUMMARY",
                  at: new Date(),
                  file_name: `retail-transaction-summary-${date}`,
                  info: [
                    ["Day", dayLabel],
                    ["Outlet", outletName],
                    ["Printed by", printedBy ?? "—"],
                  ],
                  sections: [
                    {
                      lines: [
                        ["Total sales", naira(salesValue), true],
                        ["Collected", naira(collected)],
                        ["On credit", naira(n(m?.credit_sales))],
                        ["Refunds", naira(refunds)],
                      ],
                    },
                    {
                      heading: "Payment Methods Summary",
                      columns: ["Method", "Amount(N)"],
                      rows: methods.map((r) => [methodLabel(r.method), amt(r.amount)]),
                    },
                    {
                      heading: "Product Sales Summary",
                      columns: ["Item", "Open", "In", "Out", "Ret", "Sold", "Left", "Amt(N)"],
                      rows: rows.map((r) => [
                        r.name,
                        amt(r.opening),
                        amt(r.received),
                        amt(r.out),
                        amt(r.ret),
                        amt(r.sold),
                        amt(r.closing),
                        amt(r.value),
                      ]),
                      total: [
                        "Total",
                        amt(sum("opening")),
                        amt(sum("received")),
                        amt(sum("out")),
                        amt(sum("ret")),
                        amt(sum("sold")),
                        amt(sum("closing")),
                        amt(sum("value")),
                      ],
                    },
                  ],
                  note: "Open + In - Out + Ret = Left",
                },
                copies,
              )
            }
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Qty In</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Qty Out</TableHead>
                <TableHead className="text-right">Qty Ret.</TableHead>
                <TableHead className="text-right">Qty Sold</TableHead>
                <TableHead className="text-right">In Stock</TableHead>
                <TableHead className="text-right">Sales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">
                    {r.name} <span className="text-xs text-muted-foreground">{r.unit}</span>
                  </TableCell>
                  <TableCell className="text-right">{num(r.opening)}</TableCell>
                  <TableCell className="text-right">{num(r.received)}</TableCell>
                  <TableCell className="text-right">{num(r.total)}</TableCell>
                  <TableCell className="text-right">{num(r.out)}</TableCell>
                  <TableCell className="text-right">{num(r.ret)}</TableCell>
                  <TableCell className="text-right">{num(r.sold)}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {num(r.closing)}
                    {r.closing < 0 && (
                      <Badge variant="destructive" className="ml-2">
                        Check
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{money(r.value)}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    {day.isLoading ? "Loading…" : "No stock or sales on this day."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell />
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right">{num(sum("opening"))}</TableCell>
                  <TableCell className="text-right">{num(sum("received"))}</TableCell>
                  <TableCell className="text-right">{num(sum("total"))}</TableCell>
                  <TableCell className="text-right">{num(sum("out"))}</TableCell>
                  <TableCell className="text-right">{num(sum("ret"))}</TableCell>
                  <TableCell className="text-right">{num(sum("sold"))}</TableCell>
                  <TableCell className="text-right">{num(sum("closing"))}</TableCell>
                  <TableCell className="text-right">{money(sum("value"))}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

// One row per posting: the movements that share a reference and type (a
// Warehouse posting, a sale's invoice, a customer return) are one action by
// one person.
type LogEntry = {
  key: string;
  at: string;
  type: string;
  reference: string | null;
  reason: string | null;
  userId: string | null;
  qty: number;
  items: { name: string; unit: string; qty: number }[];
};

const activityLabel = (e: LogEntry) => {
  if (e.type === "reversal") {
    if (e.qty < 0) return "Warehouse posting reversed";
    return e.reason?.startsWith("Customer return") ? "Customer return" : "Sale cancelled";
  }
  return (
    {
      dispatch_in: "Received from Warehouse",
      sold: "Sale",
      returned_out: "Returned to Warehouse",
      damaged_out: "Damaged",
      adjustment: "Adjustment",
    }[e.type] ?? e.type
  );
};

const activityVariant = (e: LogEntry): "default" | "secondary" | "destructive" | "outline" =>
  e.type === "sold"
    ? "default"
    : e.type === "dispatch_in"
      ? "secondary"
      : e.type === "reversal" || e.type === "damaged_out"
        ? "destructive"
        : "outline";

function PostingLog({ outletId, outletName, date }: PanelProps) {
  const { company, printedBy } = usePrintHeader();
  const [who, setWho] = useState("all");

  const movements = useQuery({
    queryKey: ["retail-log", outletId, date],
    queryFn: async () => {
      const { start, end } = dayBounds(date);
      const { data, error } = await supabase
        .from("rep_stock_movements")
        .select("id,created_at,movement_type,quantity,reference,reason,user_id,products(name,unit)")
        .eq("sales_rep_id", outletId)
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as Movement[];
    },
  });

  const entries = useMemo(() => {
    const byKey = new Map<string, LogEntry>();
    for (const m of movements.data ?? []) {
      const q = Number(m.quantity);
      // Reversals carry their sign: a reversed posting (out) and a customer
      // return (in) under one reference are separate actions.
      const key = `${m.movement_type}|${m.reference ?? m.id}|${m.movement_type === "reversal" && q < 0 ? "-" : ""}`;
      const e = byKey.get(key) ?? {
        key,
        at: m.created_at,
        type: m.movement_type,
        reference: m.reference,
        reason: m.reason,
        userId: m.user_id,
        qty: 0,
        items: [],
      };
      if (m.created_at < e.at) e.at = m.created_at;
      e.qty += q;
      e.items.push({
        name: m.products?.name ?? "—",
        unit: m.products?.unit ?? "",
        qty: Math.abs(q),
      });
      byKey.set(key, e);
    }
    return [...byKey.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [movements.data]);

  const userIds = [...new Set(entries.map((e) => e.userId).filter(Boolean))] as string[];
  const people = useQuery({
    queryKey: ["retail-log-people", userIds.join(",")],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id,full_name,email")
        .in("id", userIds);
      return new Map((data ?? []).map((p) => [p.id, p.full_name || p.email || "—"]));
    },
  });
  const nameOf = (id: string | null) => (id && people.data?.get(id)) || "—";
  const whoName = (id: string) => (id === SYSTEM ? "System" : nameOf(id));

  // The sale behind each Sale row (its reference is the invoice number).
  const invoices = entries.filter((e) => e.type === "sold" && e.reference).map((e) => e.reference!);
  const sales = useQuery({
    queryKey: ["retail-log", "sales", outletId, date, invoices.join(",")],
    enabled: invoices.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("invoice_number,grand_total,payment_method,customer_name,status")
        .eq("sales_rep_id", outletId)
        .in("invoice_number", invoices);
      if (error) throw error;
      return new Map(((data ?? []) as SaleInfo[]).map((s) => [s.invoice_number, s]));
    },
  });
  const saleOf = (e: LogEntry) =>
    e.type === "sold" && e.reference ? sales.data?.get(e.reference) : undefined;

  const shown = who === "all" ? entries : entries.filter((e) => (e.userId ?? SYSTEM) === who);

  // Per person: how many postings, how many sales and their value.
  const perPerson = useMemo(() => {
    const map = new Map<
      string,
      { id: string; postings: number; sales: number; value: number; last: string }
    >();
    for (const e of entries) {
      const id = e.userId ?? SYSTEM;
      const r = map.get(id) ?? { id, postings: 0, sales: 0, value: 0, last: e.at };
      r.postings += 1;
      if (e.type === "sold") {
        r.sales += 1;
        r.value += n(sales.data?.get(e.reference ?? "")?.grand_total);
      }
      if (e.at > r.last) r.last = e.at;
      map.set(id, r);
    }
    return [...map.values()].sort((a, b) => b.postings - a.postings);
  }, [entries, sales.data]);

  const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Who posted</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Posted by</TableHead>
                <TableHead className="text-right">Postings</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Sales value</TableHead>
                <TableHead className="text-right">Last posting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {perPerson.map((p) => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer"
                  onClick={() => setWho(who === p.id ? "all" : p.id)}
                  data-state={who === p.id ? "selected" : undefined}
                >
                  <TableCell className="font-medium">{whoName(p.id)}</TableCell>
                  <TableCell className="text-right">{num(p.postings)}</TableCell>
                  <TableCell className="text-right">{num(p.sales)}</TableCell>
                  <TableCell className="text-right">{money(p.value)}</TableCell>
                  <TableCell className="text-right">{fmtTime(p.last)}</TableCell>
                </TableRow>
              ))}
              {perPerson.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {movements.isLoading ? "Loading…" : "Nothing posted on this day."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Posting log</CardTitle>
            <p className="text-sm text-muted-foreground">
              Latest first. Click a person above to see only their postings.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={who} onValueChange={setWho}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {perPerson.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {whoName(p.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <PrintCopiesButton
              title="Print posting log"
              onPrint={(copies) =>
                printRollReport(
                  {
                    company,
                    title: "POSTING LOG",
                    at: new Date(),
                    file_name: `retail-posting-log-${date}`,
                    info: [
                      ["Day", dayLabel],
                      ["Outlet", outletName],
                      ["Posted by", who === "all" ? "Everyone" : whoName(who)],
                      ["Printed by", printedBy ?? "—"],
                    ],
                    sections: [
                      {
                        heading: "Who posted",
                        columns: ["Name", "Posts", "Sales(N)", "Last"],
                        rows: perPerson
                          .filter((p) => who === "all" || p.id === who)
                          .map((p) => [
                            whoName(p.id),
                            amt(p.postings),
                            amt(p.value),
                            fmtTime(p.last),
                          ]),
                      },
                      // Oldest first on paper, as the day ran.
                      ...[...shown].reverse().map((e) => {
                        const s = saleOf(e);
                        return {
                          heading: `${fmtTime(e.at)}  ${activityLabel(e)} - ${whoName(e.userId ?? SYSTEM)}${e.reference ? ` (${e.reference})` : ""}`,
                          columns: ["Item", "Qty"],
                          rows: e.items.map((it) => [it.name, amt(it.qty)]),
                          lines: s
                            ? ([[methodLabel(s.payment_method), naira(n(s.grand_total))]] as [
                                string,
                                string,
                              ][])
                            : undefined,
                        };
                      }),
                    ],
                  },
                  copies,
                )
              }
            />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Posted by</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Products</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((e) => {
                const s = saleOf(e);
                return (
                  <TableRow key={e.key}>
                    <TableCell className="whitespace-nowrap font-medium">{fmtTime(e.at)}</TableCell>
                    <TableCell>{whoName(e.userId ?? SYSTEM)}</TableCell>
                    <TableCell>
                      <Badge variant={activityVariant(e)}>{activityLabel(e)}</Badge>
                      {e.reference && (
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {e.reference}
                        </div>
                      )}
                      {s?.customer_name && (
                        <div className="text-xs text-muted-foreground">{s.customer_name}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {e.items.map((it, i) => (
                        <div key={i}>
                          {it.name} × {num(it.qty)} {it.unit}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {s ? (
                        <>
                          <div className="font-medium">{money(n(s.grand_total))}</div>
                          <div className="text-xs text-muted-foreground">
                            {methodLabel(s.payment_method)}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {movements.isLoading ? "Loading…" : "Nothing posted on this day."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
