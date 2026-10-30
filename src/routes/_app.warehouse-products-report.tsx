import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
import { DatePicker } from "@/components/shared/date-picker";
import { ReportActions } from "@/components/shared/report-actions";
import { Input } from "@/components/ui/input";
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

export const Route = createFileRoute("/_app/warehouse-products-report")({
  head: () => ({
    meta: [
      { title: "Warehouse Products Report — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="finished-goods">
        <ProductsReportPage />
      </RequireAccess>
    </>
  ),
});

// The Warehouse's day per finished product, laid out as the old system's
// "All Products Reports": Opening, Qty In, Total, Qty Out, Returned,
// Gift/Sample, Balance -- plus Adjusted for stock corrections (e.g. the move
// from the old system), so every row adds up. Pick the day on the calendar
// (warehouse_products_report,
// supabase/migrations/20261030140000_warehouse_products_report.sql).

type Row = {
  product_id: string;
  product: string;
  unit: string;
  opening: number;
  qty_in: number;
  total: number;
  qty_out: number;
  returned: number;
  gift: number;
  adjusted: number;
  balance: number;
};

const COLS = [
  "opening",
  "qty_in",
  "total",
  "qty_out",
  "returned",
  "gift",
  "adjusted",
  "balance",
] as const;

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const signed = (v: number) => (v > 0 ? `+${num(v)}` : num(v));

function ProductsReportPage() {
  const { data: factoryId } = useFactoryId();
  const today = lagosToday();
  const [date, setDate] = useState(today);
  const [q, setQ] = useState("");

  useRealtimeInvalidate(["inventory_movements", "products"], [["warehouse-products-report"]]);

  const report = useQuery({
    queryKey: ["warehouse-products-report", factoryId, date],
    enabled: !!factoryId && !!date,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_products_report" as never,
        { p_factory: factoryId, p_date: date } as never,
      );
      if (error) throw error;
      return ((data ?? []) as unknown as Row[]).map((r) => {
        const out = { ...r };
        for (const c of COLS) out[c] = Number(r[c] ?? 0);
        return out;
      });
    },
  });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (report.data ?? []).filter((r) => !term || r.product.toLowerCase().includes(term));
  }, [report.data, q]);
  const sum = (k: (typeof COLS)[number]) => rows.reduce((t, r) => t + r[k], 0);
  const anyAdjusted = rows.some((r) => r.adjusted !== 0);

  if (!factoryId) return null;
  const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">All Products Report</h1>
        <p className="text-sm text-muted-foreground">
          The Warehouse&apos;s stock for each product on a day: opening, in, out, returned,
          gifts/samples and the balance left.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 space-y-0">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Date</div>
              <DatePicker value={date} max={today} onChange={setDate} />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Filter by product</div>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="w-56 pl-8"
                  placeholder="Product name"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
            </div>
          </div>
          <ReportActions
            title="All Products Report"
            fileName={`warehouse-products-report-${date}`}
            columns={[
              { key: "sn", label: "S/N" },
              { key: "product", label: "Product" },
              { key: "opening", label: "Opening" },
              { key: "qty_in", label: "Qty In" },
              { key: "total", label: "Total" },
              { key: "qty_out", label: "Qty Out" },
              { key: "returned", label: "Returned" },
              { key: "gift", label: "Gift/Sample" },
              ...(anyAdjusted ? [{ key: "adjusted", label: "Adjusted / B/F" }] : []),
              { key: "balance", label: "Balance" },
              { key: "date", label: "Date" },
            ]}
            rows={[
              ...rows.map((r, i) => ({
                sn: i + 1,
                product: `${r.product} (${r.unit})`,
                opening: num(r.opening),
                qty_in: num(r.qty_in),
                total: num(r.total),
                qty_out: num(r.qty_out),
                returned: num(r.returned),
                gift: num(r.gift),
                adjusted: signed(r.adjusted),
                balance: num(r.balance),
                date,
              })),
              ...(rows.length
                ? [
                    {
                      sn: "",
                      product: "Total",
                      opening: num(sum("opening")),
                      qty_in: num(sum("qty_in")),
                      total: num(sum("total")),
                      qty_out: num(sum("qty_out")),
                      returned: num(sum("returned")),
                      gift: num(sum("gift")),
                      adjusted: signed(sum("adjusted")),
                      balance: num(sum("balance")),
                      date: "",
                    },
                  ]
                : []),
            ]}
            subtitle={[`Warehouse — ${dayLabel}`]}
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
                <TableHead className="text-right">Returned</TableHead>
                <TableHead className="text-right">Gift/Sample</TableHead>
                {anyAdjusted && <TableHead className="text-right">Adjusted / B/F</TableHead>}
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.product_id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">
                    {r.product} <span className="text-xs text-muted-foreground">{r.unit}</span>
                  </TableCell>
                  <TableCell className="text-right">{num(r.opening)}</TableCell>
                  <TableCell className="text-right">{num(r.qty_in)}</TableCell>
                  <TableCell className="text-right">{num(r.total)}</TableCell>
                  <TableCell className="text-right">{num(r.qty_out)}</TableCell>
                  <TableCell className="text-right">{num(r.returned)}</TableCell>
                  <TableCell className="text-right">{num(r.gift)}</TableCell>
                  {anyAdjusted && (
                    <TableCell
                      className={`text-right ${r.adjusted < 0 ? "text-destructive" : r.adjusted > 0 ? "text-success" : ""}`}
                    >
                      {signed(r.adjusted)}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-semibold">{num(r.balance)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{date}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={anyAdjusted ? 11 : 10}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {report.isLoading
                      ? "Loading…"
                      : report.isError
                        ? (report.error as Error).message
                        : "No products."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell />
                  <TableCell>Total</TableCell>
                  {COLS.filter((c) => c !== "adjusted" || anyAdjusted).map((c) => (
                    <TableCell key={c} className="text-right">
                      {c === "adjusted" ? signed(sum(c)) : num(sum(c))}
                    </TableCell>
                  ))}
                  <TableCell />
                </TableRow>
              </TableFooter>
            )}
          </Table>
          {anyAdjusted && (
            <p className="mt-3 text-xs text-muted-foreground">
              Adjusted / B/F: stock corrections on the day, and the balance brought forward from the
              old system on 30 Oct 2026. Opening + Qty In − Qty Out + Returned − Gift/Sample +
              Adjusted = Balance.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
