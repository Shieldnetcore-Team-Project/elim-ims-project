import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
import { generateProductionStockReportPdf } from "@/lib/pdf";
import { exportCsv } from "@/lib/export";
import { SHIFT_LABEL, type Shift } from "@/lib/production-shift";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, Printer } from "lucide-react";

export const Route = createFileRoute("/_app/production-report")({
  head: () => ({
    meta: [
      { title: "Production Report — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Production" />
      <RequireAccess module="production">
        <ProductionReportPage />
      </RequireAccess>
    </>
  ),
});

// Production hall stock, per product, for a date range:
//
//   Opening   still in the production hall when the period starts
//   Produced  good quantity of batches produced in the period (by production
//             date; damage known at production is excluded)
//   Total     Opening + Produced
//   Released  released from the hall to the Warehouse in the period (by the
//             release's date)
//   Balance   Total - Released: still in the hall when the period ends, and the
//             next period's Opening
//
// Production runs past the Warehouse's 6 p.m. close, so a night batch counts on
// its production day but is released the next morning: that day closes with a
// balance, which opens the next day. Same rules as the live hall balance
// (production_hall_stock): cancelled/rejected batches never count, and a
// release the Warehouse refused or Production withdrew went back into the hall.
// Batches the Warehouse accepted whole before releases existed count as
// released on the day they were accepted.

type Batch = {
  product_id: string;
  quantity_produced: number;
  damaged_quantity: number | null;
  production_date: string;
  shift: Shift | null;
  confirmed_at: string | null;
  status: string;
  products: { name: string } | null;
};
type Release = {
  product_id: string;
  quantity: number;
  released_at: string;
  products: { name: string } | null;
};

const LIVE = ["pending_confirmation", "confirmed", "posted"];
// Accepted whole by the Warehouse, before releases existed.
const ACCEPTED_WHOLE = ["confirmed", "posted"];

// YYYY-MM-DD in the user's own timezone (the factory's working day).
const localDay = (d: Date) => d.toLocaleDateString("en-CA");
const shift = (day: string, days: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDay(d);
};
const startOfWeek = (day: string) => {
  const d = new Date(`${day}T12:00:00`);
  const back = (d.getDay() + 6) % 7; // Monday
  return shift(day, -back);
};

function ProductionReportPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const today = localDay(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  useRealtimeInvalidate(
    ["production", "production_releases"],
    [["production-report"], ["production-report-releases"]],
  );

  // Every live batch produced up to the end of the period: earlier ones make
  // up the opening balance. Paged, since the history only grows.
  const batches = useQuery({
    queryKey: ["production-report", factoryId, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const all: Batch[] = [];
      const page = 1000;
      for (let fromRow = 0; ; fromRow += page) {
        const { data, error } = await supabase
          .from("production")
          .select(
            "product_id,quantity_produced,damaged_quantity,production_date,shift,confirmed_at,status,products(name)",
          )
          .eq("factory_id", factoryId!)
          .in("status", LIVE)
          .lte("production_date", to)
          .order("production_date")
          .range(fromRow, fromRow + page - 1);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as Batch[]));
        if (!data || data.length < page) break;
      }
      return all;
    },
  });

  // Releases still counting as out of the hall (pending or accepted), up to the
  // end of the period.
  const releases = useQuery({
    queryKey: ["production-report-releases", factoryId, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const all: Release[] = [];
      const page = 1000;
      const end = new Date(`${shift(to, 1)}T00:00:00`).toISOString();
      for (let fromRow = 0; ; fromRow += page) {
        const { data, error } = await supabase
          .from("production_releases")
          .select("product_id,quantity,released_at,products(name)")
          .eq("factory_id", factoryId!)
          .in("status", ["pending", "accepted"])
          .lt("released_at", end)
          .order("released_at")
          .range(fromRow, fromRow + page - 1);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as Release[]));
        if (!data || data.length < page) break;
      }
      return all;
    },
  });

  // List every product, including ones with nothing this period.
  const products = useQuery({
    queryKey: ["production-report-products", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,product_categories(name)")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) return [] as ReportProduct[];
      return (data ?? []) as unknown as ReportProduct[];
    },
  });

  const rows = useMemo(() => {
    const byProduct = new Map<
      string,
      { product: string; opening: number; produced: number; released: number }
    >();
    const row = (id: string, name: string) => {
      let r = byProduct.get(id);
      if (!r) {
        r = { product: name, opening: 0, produced: 0, released: 0 };
        byProduct.set(id, r);
      }
      return r;
    };
    for (const p of products.data ?? []) row(p.id, p.name);
    const out = (id: string, name: string, qty: number, day: string) => {
      const r = row(id, name);
      if (day < from) r.opening -= qty;
      else if (day <= to) r.released += qty;
    };
    for (const b of batches.data ?? []) {
      const r = row(b.product_id, b.products?.name ?? "—");
      const qty = Number(b.quantity_produced) - Number(b.damaged_quantity ?? 0);
      if (b.production_date < from) r.opening += qty;
      else r.produced += qty;
      if (ACCEPTED_WHOLE.includes(b.status) && b.confirmed_at)
        out(b.product_id, b.products?.name ?? "—", qty, localDay(new Date(b.confirmed_at)));
    }
    for (const rel of releases.data ?? [])
      out(
        rel.product_id,
        rel.products?.name ?? "—",
        Number(rel.quantity),
        localDay(new Date(rel.released_at)),
      );
    return [...byProduct.values()]
      .map((r) => {
        const total = r.opening + r.produced;
        return { ...r, total, balance: total - r.released };
      })
      .sort((a, b) => a.product.localeCompare(b.product));
  }, [batches.data, releases.data, products.data, from, to]);

  const sum = (k: "opening" | "produced" | "total" | "released" | "balance") =>
    rows.reduce((t, r) => t + r[k], 0);

  const print = (action: "print" | "download") =>
    generateProductionStockReportPdf(
      {
        company: {
          name: settings.data?.company_name,
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          logo_url: settings.data?.logo_url,
        },
        from,
        to,
        rows,
      },
      action,
    );

  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = shift(monthStart, -1);
  const quick: { label: string; from: string; to: string }[] = [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: shift(today, -1), to: shift(today, -1) },
    { label: "This week", from: startOfWeek(today), to: today },
    { label: "Last week", from: shift(startOfWeek(today), -7), to: shift(startOfWeek(today), -1) },
    { label: "This month", from: monthStart, to: today },
    { label: "Last month", from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];

  if (!factoryId) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products Report</h1>
          <p className="text-sm text-muted-foreground">
            What is in the production hall: opening balance, produced, released to the Warehouse,
            and the closing balance that opens the next day.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="gap-2" onClick={() => print("print")}>
            <Printer className="h-4 w-4" /> Print
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => print("download")}>
            <Download className="h-4 w-4" /> PDF
          </Button>
        </div>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          {quick.map((q) => (
            <Button
              key={q.label}
              size="sm"
              variant={from === q.from && to === q.to ? "default" : "outline"}
              onClick={() => {
                setFrom(q.from);
                setTo(q.to);
              }}
            >
              {q.label}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">
            Production Department: Products Report from {from} to {to}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Produced</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Released</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.product + i}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">{r.product}</TableCell>
                  <TableCell className="text-right">{num(r.opening)}</TableCell>
                  <TableCell className="text-right">{num(r.produced)}</TableCell>
                  <TableCell className="text-right">{num(r.total)}</TableCell>
                  <TableCell className="text-right">{num(r.released)}</TableCell>
                  <TableCell
                    className={`text-right font-semibold ${r.balance > 0 ? "text-warning" : ""}`}
                  >
                    {num(r.balance)}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {batches.isLoading ? "Loading…" : "No products yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2}>Total</TableCell>
                  <TableCell className="text-right">{num(sum("opening"))}</TableCell>
                  <TableCell className="text-right">{num(sum("produced"))}</TableCell>
                  <TableCell className="text-right">{num(sum("total"))}</TableCell>
                  <TableCell className="text-right">{num(sum("released"))}</TableCell>
                  <TableCell className="text-right">{num(sum("balance"))}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">
            Produced counts by production date; Released counts by the day Production released it to
            the Warehouse. Production after the Warehouse closes is released the next morning, so it
            shows as that day&apos;s Balance and the next day&apos;s Opening.
          </p>
        </CardContent>
      </Card>

      <ProductTypeSummary
        batches={batches.data ?? []}
        products={products.data ?? []}
        from={from}
        to={to}
      />

      <ShiftBreakdown batches={batches.data ?? []} from={from} to={to} />
    </div>
  );
}

type ReportProduct = { id: string; name: string; product_categories: { name: string } | null };
type TypeRow = { name: string; category: string; night: number; day: number; other: number };

// The general record: everything produced in the period, per product, grouped
// by product type (category: Bottle / Dispenser / Sachet Water), with Night,
// Day and total, and a subtotal for each type.
function ProductTypeSummary({
  batches,
  products,
  from,
  to,
}: {
  batches: Batch[];
  products: ReportProduct[];
  from: string;
  to: string;
}) {
  const groups = useMemo(() => {
    const catOf = new Map(
      products.map((p) => [p.id, p.product_categories?.name ?? "Uncategorised"]),
    );
    const byProduct = new Map<
      string,
      { name: string; category: string; night: number; day: number; other: number }
    >();
    for (const p of products)
      byProduct.set(p.id, { name: p.name, category: catOf.get(p.id)!, night: 0, day: 0, other: 0 });
    for (const b of batches) {
      if (b.production_date < from || b.production_date > to) continue;
      let r = byProduct.get(b.product_id);
      if (!r) {
        r = {
          name: b.products?.name ?? "—",
          category: catOf.get(b.product_id) ?? "Uncategorised",
          night: 0,
          day: 0,
          other: 0,
        };
        byProduct.set(b.product_id, r);
      }
      const qty = Number(b.quantity_produced) - Number(b.damaged_quantity ?? 0);
      if (b.shift === "night") r.night += qty;
      else if (b.shift === "day") r.day += qty;
      else r.other += qty;
    }
    const cats = new Map<string, TypeRow[]>();
    for (const r of byProduct.values()) {
      const list = cats.get(r.category) ?? [];
      list.push(r);
      cats.set(r.category, list);
    }
    return [...cats.entries()]
      .sort(([a], [b]) =>
        a === "Uncategorised" ? 1 : b === "Uncategorised" ? -1 : a.localeCompare(b),
      )
      .map(([category, items]) => ({
        category,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
        night: items.reduce((t, r) => t + r.night, 0),
        day: items.reduce((t, r) => t + r.day, 0),
        other: items.reduce((t, r) => t + r.other, 0),
      }));
  }, [batches, products, from, to]);

  const showOther = groups.some((g) => g.other > 0);
  const grand = groups.reduce(
    (t, g) => ({ night: t.night + g.night, day: t.day + g.day, other: t.other + g.other }),
    { night: 0, day: 0, other: 0 },
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="text-base">Totals by product type</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          The general record of everything produced from {from} to {to}, for each type of product.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Night</TableHead>
              <TableHead className="text-right">Day</TableHead>
              {showOther && <TableHead className="text-right">No shift</TableHead>}
              <TableHead className="text-right">Total produced</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <Fragment key={g.category}>
                <TableRow className="bg-muted/40">
                  <TableCell className="font-semibold">{g.category}</TableCell>
                  <TableCell className="text-right font-semibold">{num(g.night)}</TableCell>
                  <TableCell className="text-right font-semibold">{num(g.day)}</TableCell>
                  {showOther && (
                    <TableCell className="text-right font-semibold">{num(g.other)}</TableCell>
                  )}
                  <TableCell className="text-right font-semibold">
                    {num(g.night + g.day + g.other)}
                  </TableCell>
                </TableRow>
                {g.items.map((r) => (
                  <TableRow key={g.category + r.name}>
                    <TableCell className="pl-8">{r.name}</TableCell>
                    <TableCell className="text-right">{r.night ? num(r.night) : "—"}</TableCell>
                    <TableCell className="text-right">{r.day ? num(r.day) : "—"}</TableCell>
                    {showOther && (
                      <TableCell className="text-right">{r.other ? num(r.other) : "—"}</TableCell>
                    )}
                    <TableCell className="text-right">{num(r.night + r.day + r.other)}</TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
            {groups.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No products yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {groups.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell>All products</TableCell>
                <TableCell className="text-right">{num(grand.night)}</TableCell>
                <TableCell className="text-right">{num(grand.day)}</TableCell>
                {showOther && <TableCell className="text-right">{num(grand.other)}</TableCell>}
                <TableCell className="text-right">
                  {num(grand.night + grand.day + grand.other)}
                </TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}

type Group = "day" | "week" | "month";
const GROUP_LABEL: Record<Group, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

// What was produced in the period, per product, split by shift (Day / Night)
// and grouped by day, week or month. Batches recorded before shifts existed
// show as "—".
function ShiftBreakdown({ batches, from, to }: { batches: Batch[]; from: string; to: string }) {
  const [group, setGroup] = useState<Group>("day");

  const { products, rows, totals } = useMemo(() => {
    const periodOf = (day: string) =>
      group === "day" ? day : group === "week" ? startOfWeek(day) : day.slice(0, 7);
    const productNames = new Map<string, string>();
    const byKey = new Map<
      string,
      { period: string; shift: Shift | null; qty: Map<string, number>; total: number }
    >();
    const totals = new Map<string, number>();
    for (const b of batches) {
      if (b.production_date < from || b.production_date > to) continue;
      const qty = Number(b.quantity_produced) - Number(b.damaged_quantity ?? 0);
      const period = periodOf(b.production_date);
      const key = `${period}|${b.shift ?? ""}`;
      let r = byKey.get(key);
      if (!r) {
        r = { period, shift: b.shift, qty: new Map(), total: 0 };
        byKey.set(key, r);
      }
      productNames.set(b.product_id, b.products?.name ?? "—");
      r.qty.set(b.product_id, (r.qty.get(b.product_id) ?? 0) + qty);
      r.total += qty;
      totals.set(b.product_id, (totals.get(b.product_id) ?? 0) + qty);
    }
    const shiftOrder = (s: Shift | null) => (s === "night" ? 0 : s === "day" ? 1 : 2);
    const rows = [...byKey.values()].sort(
      (a, b) => a.period.localeCompare(b.period) || shiftOrder(a.shift) - shiftOrder(b.shift),
    );
    const products = [...productNames.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { products, rows, totals };
  }, [batches, from, to, group]);

  const periodLabel = (p: string) =>
    group === "day"
      ? new Date(`${p}T12:00:00`).toLocaleDateString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : group === "week"
        ? `Week of ${new Date(`${p}T12:00:00`).toLocaleDateString()}`
        : new Date(`${p}-01T12:00:00`).toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          });

  const grand = rows.reduce((t, r) => t + r.total, 0);

  const download = () =>
    exportCsv(
      `production-by-shift-${from}-to-${to}`,
      [
        { key: "period", label: group === "day" ? "Date" : group === "week" ? "Week" : "Month" },
        { key: "shift", label: "Shift" },
        ...products.map((p) => ({ key: p.id, label: p.name })),
        { key: "total", label: "Total" },
      ],
      rows.map((r) => ({
        period: periodLabel(r.period),
        shift: r.shift ? SHIFT_LABEL[r.shift] : "—",
        ...Object.fromEntries(products.map((p) => [p.id, r.qty.get(p.id) ?? 0])),
        total: r.total,
      })),
    );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">Produced by shift</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Every product produced from {from} to {to}, by Night and Day shift.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(GROUP_LABEL) as Group[]).map((g) => (
            <Button
              key={g}
              size="sm"
              variant={group === g ? "default" : "outline"}
              onClick={() => setGroup(g)}
            >
              {GROUP_LABEL[g]}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            disabled={!rows.length}
            onClick={download}
          >
            <Download className="h-4 w-4" /> CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {group === "day" ? "Date" : group === "week" ? "Week" : "Month"}
              </TableHead>
              <TableHead>Shift</TableHead>
              {products.map((p) => (
                <TableHead key={p.id} className="text-right">
                  {p.name}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.period}|${r.shift ?? ""}`}>
                <TableCell className="whitespace-nowrap">{periodLabel(r.period)}</TableCell>
                <TableCell>{r.shift ? SHIFT_LABEL[r.shift] : "—"}</TableCell>
                {products.map((p) => (
                  <TableCell key={p.id} className="text-right">
                    {r.qty.get(p.id) ? num(r.qty.get(p.id)!) : "—"}
                  </TableCell>
                ))}
                <TableCell className="text-right font-semibold">{num(r.total)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={products.length + 3}
                  className="py-8 text-center text-muted-foreground"
                >
                  Nothing produced in this period.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {rows.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>Total</TableCell>
                {products.map((p) => (
                  <TableCell key={p.id} className="text-right">
                    {num(totals.get(p.id) ?? 0)}
                  </TableCell>
                ))}
                <TableCell className="text-right">{num(grand)}</TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}
