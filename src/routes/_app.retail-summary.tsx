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
import { ReportActions } from "@/components/shared/report-actions";
import { RetailJars } from "@/components/retail/retail-jars";

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
//   Posting Log (?tab=log)  what the Warehouse posted to the shop that day:
//                        who posted it, at what time, and the products. The
//                        shop's own sales and returns are not listed.
// Both read only; nothing here moves stock.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
const db = supabase as any;

const n = (v: unknown) => Number(v ?? 0);
// Roll prints write numbers as the Warehouse slip does (N104000, 51000): no
// ₦ sign, no thousands commas -- narrower on the 72mm roll.
const amt = (v: number) => String(Math.round(v));
const naira = (v: number) => `N${amt(v)}`;
const qty = amt;

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
  unit_price: number;
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
  const isJars = tab === "jars";
  const outletName = outlets.data?.find((o) => o.id === outletId)?.full_name ?? "Retail Shop";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isJars
              ? "Dispenser jars"
              : isLog
                ? "Postings from the Warehouse"
                : "Transaction Summary"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isJars
              ? "Filled and empty jars at the shop, empties customers still owe, and empties sent to the Warehouse."
              : isLog
                ? "Products the Warehouse posted to the shop: who posted them, the day and the time."
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
      ) : !outletId ? null : isJars ? (
        <RetailJars outletId={outletId} date={date} />
      ) : isLog ? (
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
          price: n(p.unit_price),
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
          </div>
          {/* On A4, the full table as on screen; the money and payment
              methods go in the heading lines. */}
          <ReportActions
            size="sm"
            title="Transaction Summary"
            fileName={`retail-transaction-summary-${date}`}
            columns={[
              { key: "sn", label: "S/N" },
              { key: "product", label: "Product" },
              { key: "opening", label: "Opening" },
              { key: "received", label: "Qty In" },
              { key: "total", label: "Total" },
              { key: "out", label: "Qty Out" },
              { key: "ret", label: "Qty Ret." },
              { key: "sold", label: "Qty Sold" },
              { key: "closing", label: "In Stock" },
              { key: "value", label: "Sales" },
            ]}
            rows={[
              ...rows.map((r, i) => ({
                sn: i + 1,
                product: r.name,
                opening: num(r.opening),
                received: num(r.received),
                total: num(r.total),
                out: num(r.out),
                ret: num(r.ret),
                sold: num(r.sold),
                closing: num(r.closing),
                value: money(r.value),
              })),
              ...(rows.length
                ? [
                    {
                      sn: "",
                      product: "Total",
                      opening: num(sum("opening")),
                      received: num(sum("received")),
                      total: num(sum("total")),
                      out: num(sum("out")),
                      ret: num(sum("ret")),
                      sold: num(sum("sold")),
                      closing: num(sum("closing")),
                      value: money(sum("value")),
                    },
                  ]
                : []),
            ]}
            subtitle={[
              `${outletName} — ${dayLabel}`,
              `Total sales: ${money(salesValue)} · Collected: ${money(collected)} · On credit: ${money(n(m?.credit_sales))} · Refunds: ${money(refunds)}`,
              `Payment methods: ${
                methods.map((r) => `${methodLabel(r.method)} ${money(r.amount)}`).join(" · ") ||
                "none"
              }`,
            ]}
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

// One row per Warehouse posting to the shop: its dispatch_in lines share one
// reference. A posting the Warehouse later reversed has negative 'reversal'
// lines under the same reference. The shop's own sales and returns are not
// listed -- only what the Warehouse sent.
type WarehousePosting = {
  reference: string;
  at: string;
  userId: string | null;
  items: { name: string; unit: string; qty: number }[];
  reversed: boolean;
};

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
        .in("movement_type", ["dispatch_in", "reversal"])
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as Movement[];
    },
  });

  const postings = useMemo(() => {
    const byRef = new Map<string, WarehousePosting>();
    for (const m of movements.data ?? []) {
      if (m.movement_type !== "dispatch_in") continue;
      const ref = m.reference ?? m.id;
      const p = byRef.get(ref) ?? {
        reference: ref,
        at: m.created_at,
        userId: m.user_id,
        items: [],
        reversed: false,
      };
      if (m.created_at < p.at) p.at = m.created_at;
      p.items.push({
        name: m.products?.name ?? "—",
        unit: m.products?.unit ?? "",
        qty: Number(m.quantity),
      });
      byRef.set(ref, p);
    }
    for (const m of movements.data ?? []) {
      const p = m.reference ? byRef.get(m.reference) : undefined;
      if (p && m.movement_type === "reversal" && Number(m.quantity) < 0) p.reversed = true;
    }
    return [...byRef.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [movements.data]);

  const userIds = [...new Set(postings.map((p) => p.userId).filter(Boolean))] as string[];
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
  const whoName = (id: string) => (id === SYSTEM ? "System" : people.data?.get(id) || "—");
  const packs = (p: WarehousePosting) => p.items.reduce((t, it) => t + it.qty, 0);

  const shown = who === "all" ? postings : postings.filter((p) => (p.userId ?? SYSTEM) === who);

  // Per Warehouse person: how many postings and packs, first and last time.
  const perPerson = useMemo(() => {
    const map = new Map<
      string,
      { id: string; postings: number; packs: number; first: string; last: string }
    >();
    for (const p of postings) {
      if (p.reversed) continue;
      const id = p.userId ?? SYSTEM;
      const r = map.get(id) ?? { id, postings: 0, packs: 0, first: p.at, last: p.at };
      r.postings += 1;
      r.packs += packs(p);
      if (p.at < r.first) r.first = p.at;
      if (p.at > r.last) r.last = p.at;
      map.set(id, r);
    }
    return [...map.values()].sort((a, b) => b.postings - a.postings);
  }, [postings]);

  // Per product: what the Warehouse posted to the shop on the day (reversed
  // postings left out).
  const perProduct = useMemo(() => {
    const map = new Map<string, { name: string; unit: string; qty: number }>();
    for (const p of shown) {
      if (p.reversed) continue;
      for (const it of p.items) {
        const r = map.get(it.name) ?? { name: it.name, unit: it.unit, qty: 0 };
        r.qty += it.qty;
        map.set(it.name, r);
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [shown]);

  const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const none = movements.isLoading
    ? "Loading…"
    : "The Warehouse posted nothing to the shop on this day.";

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Who posted from the Warehouse</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Posted by</TableHead>
                  <TableHead className="text-right">Postings</TableHead>
                  <TableHead className="text-right">Packs</TableHead>
                  <TableHead className="text-right">First</TableHead>
                  <TableHead className="text-right">Last</TableHead>
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
                    <TableCell className="text-right">{num(p.packs)}</TableCell>
                    <TableCell className="text-right">{fmtTime(p.first)}</TableCell>
                    <TableCell className="text-right">{fmtTime(p.last)}</TableCell>
                  </TableRow>
                ))}
                {perPerson.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                      {none}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Products received</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perProduct.map((r) => (
                  <TableRow key={r.name}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-right">
                      {num(r.qty)} {r.unit}
                    </TableCell>
                  </TableRow>
                ))}
                {perProduct.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={2} className="py-6 text-center text-muted-foreground">
                      Nothing received.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Postings from the Warehouse</CardTitle>
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
              title="Print Warehouse postings"
              onPrint={(copies) =>
                printRollReport(
                  {
                    company,
                    title: "WAREHOUSE POSTINGS",
                    at: new Date(),
                    file_name: `retail-warehouse-postings-${date}`,
                    info: [
                      ["Day", dayLabel],
                      ["To", outletName],
                      ["Posted by", who === "all" ? "Everyone" : whoName(who)],
                      ["Printed by", printedBy ?? "—"],
                    ],
                    sections: [
                      // Oldest first on paper, as the day ran.
                      ...[...shown].reverse().map((p) => ({
                        heading: `${fmtTime(p.at)}  ${whoName(p.userId ?? SYSTEM)}  (${p.reference})${p.reversed ? " REVERSED" : ""}`,
                        columns: ["Item", "Qty"],
                        rows: p.items.map((it) => [it.name, qty(it.qty)]),
                      })),
                      {
                        heading: "Total received",
                        columns: ["Item", "Qty"],
                        rows: perProduct.map((r) => [r.name, qty(r.qty)]),
                        total: ["Total", qty(perProduct.reduce((t, r) => t + r.qty, 0))],
                      },
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
                <TableHead>Posting</TableHead>
                <TableHead>Products</TableHead>
                <TableHead className="text-right">Packs</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p) => (
                <TableRow
                  key={p.reference}
                  className={p.reversed ? "text-muted-foreground" : undefined}
                >
                  <TableCell className="whitespace-nowrap font-medium">
                    {fmtTime(p.at)}
                    <div className="text-xs font-normal text-muted-foreground">
                      {new Date(p.at).toLocaleDateString()}
                    </div>
                  </TableCell>
                  <TableCell>{whoName(p.userId ?? SYSTEM)}</TableCell>
                  <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                  <TableCell className="text-sm">
                    {p.items.map((it, i) => (
                      <div key={i}>
                        {it.name} × {num(it.qty)} {it.unit}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="text-right font-medium">{num(packs(p))}</TableCell>
                  <TableCell>
                    {p.reversed ? (
                      <Badge variant="destructive">Reversed</Badge>
                    ) : (
                      <Badge variant="secondary">Received</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    {none}
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
