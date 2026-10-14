import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
import { generateProductionStockReportPdf } from "@/lib/pdf";
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
            "product_id,quantity_produced,damaged_quantity,production_date,confirmed_at,status,products(name)",
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
        .select("id,name")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) return [] as { id: string; name: string }[];
      return data ?? [];
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

  const quick: { label: string; from: string; to: string }[] = [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: shift(today, -1), to: shift(today, -1) },
    { label: "This week", from: startOfWeek(today), to: today },
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
    </div>
  );
}
