import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money, num } from "@/lib/format";
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

  useRealtimeInvalidate(
    ["inventory_movements", "products"],
    [["warehouse-products-report"], ["warehouse-gift-details"]],
  );
  // Which gift lines to show: every product, or the one clicked.
  const [giftProduct, setGiftProduct] = useState<string | null>(null);

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
                  <TableCell className="text-right">
                    {r.gift > 0 ? (
                      <button
                        type="button"
                        className="font-medium text-primary underline-offset-2 hover:underline"
                        title="See the gifts / samples"
                        onClick={() => {
                          setGiftProduct(r.product_id);
                          document
                            .getElementById("gift-details")
                            ?.scrollIntoView({ behavior: "smooth" });
                        }}
                      >
                        {num(r.gift)}
                      </button>
                    ) : (
                      num(r.gift)
                    )}
                  </TableCell>
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

      <GiftDetails
        factoryId={factoryId}
        date={date}
        dayLabel={dayLabel}
        productId={giftProduct}
        productName={rows.find((r) => r.product_id === giftProduct)?.product}
        onShowAll={() => setGiftProduct(null)}
      />
    </div>
  );
}

type GiftLine = {
  at: string;
  day: string;
  reference: string;
  kind: string;
  given_to: string;
  product_id: string;
  product: string;
  unit: string;
  quantity: number;
  unit_cost: number;
  value: number;
  notes: string;
  posted_by: string;
};

const giftTime = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Every Chairman's gift and PR / sample that left the Warehouse on the day
// (warehouse_gift_details, 20261108100000): who it went to, what, how many,
// its worth at selling price and who posted it.
function GiftDetails({
  factoryId,
  date,
  dayLabel,
  productId,
  productName,
  onShowAll,
}: {
  factoryId: string;
  date: string;
  dayLabel: string;
  productId: string | null;
  productName?: string;
  onShowAll: () => void;
}) {
  const gifts = useQuery({
    queryKey: ["warehouse-gift-details", factoryId, date],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_gift_details" as never,
        { p_factory: factoryId, p_from: date, p_to: date } as never,
      );
      if (error) throw error;
      return ((data ?? []) as unknown as GiftLine[]).map((g) => ({
        ...g,
        quantity: Number(g.quantity),
        unit_cost: Number(g.unit_cost),
        value: Number(g.value),
      }));
    },
  });
  const list = (gifts.data ?? []).filter((g) => !productId || g.product_id === productId);
  const totalQty = list.reduce((t, g) => t + g.quantity, 0);
  const totalValue = list.reduce((t, g) => t + g.value, 0);

  return (
    <Card id="gift-details" className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">
            Gift / Sample details{productId && productName ? ` — ${productName}` : ""}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Chairman&apos;s gifts and PR / samples given out of the Warehouse on {dayLabel}.
            {productId && (
              <>
                {" "}
                <button type="button" className="text-primary hover:underline" onClick={onShowAll}>
                  Show every product
                </button>
              </>
            )}
          </p>
        </div>
        <ReportActions
          title="Gift / Sample details"
          fileName={`warehouse-gifts-${date}`}
          columns={[
            { key: "time", label: "Time" },
            { key: "reference", label: "Reference" },
            { key: "kind", label: "Kind" },
            { key: "given_to", label: "Given to" },
            { key: "product", label: "Product" },
            { key: "quantity", label: "Qty" },
            { key: "value", label: "Worth (selling price)" },
            { key: "notes", label: "Notes" },
            { key: "posted_by", label: "Posted by" },
          ]}
          rows={[
            ...list.map((g) => ({
              time: giftTime(g.at),
              reference: g.reference,
              kind: g.kind,
              given_to: g.given_to || "—",
              product: `${g.product} (${g.unit})`,
              quantity: num(g.quantity),
              value: money(g.value),
              notes: g.notes || "",
              posted_by: g.posted_by || "",
            })),
            ...(list.length
              ? [
                  {
                    time: "",
                    reference: "",
                    kind: "",
                    given_to: "",
                    product: "Total",
                    quantity: num(totalQty),
                    value: money(totalValue),
                    notes: "",
                    posted_by: "",
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
              <TableHead>Time</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Given to</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Worth (selling price)</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead>Posted by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((g, i) => (
              <TableRow key={`${g.reference}-${g.product_id}-${i}`}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {giftTime(g.at)}
                </TableCell>
                <TableCell className="font-mono text-xs">{g.reference}</TableCell>
                <TableCell>{g.kind}</TableCell>
                <TableCell>{g.given_to || "—"}</TableCell>
                <TableCell className="font-medium">
                  {g.product} <span className="text-xs text-muted-foreground">{g.unit}</span>
                </TableCell>
                <TableCell className="text-right">{num(g.quantity)}</TableCell>
                <TableCell className="text-right">{money(g.value)}</TableCell>
                <TableCell className="max-w-[220px] text-xs text-muted-foreground">
                  {g.notes || "—"}
                </TableCell>
                <TableCell className="text-xs">{g.posted_by || "—"}</TableCell>
              </TableRow>
            ))}
            {list.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  {gifts.isLoading
                    ? "Loading…"
                    : gifts.isError
                      ? (gifts.error as Error).message
                      : "No gifts or samples on this day."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {list.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={5}>Total</TableCell>
                <TableCell className="text-right">{num(totalQty)}</TableCell>
                <TableCell className="text-right">{money(totalValue)}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}
