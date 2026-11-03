import { useQuery } from "@tanstack/react-query";
import { Droplets } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money, num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// The day's dispenser reconciliation for one shop (shop_dispenser_day,
// supabase/migrations/20261102300000_retail_dispenser_revenue_remittance.sql):
// per jug type, the filled dispensers in and out by jar choice, the empties
// expected / back / owed / sent / confirmed / short, the POS against the
// stock, water and jar revenue; and the cash-up -- reference, who handed it
// in, who confirmed it, the remittance numbers. Shown on the shop's day close
// and in Accounts' review of the day.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
const db = supabase as any;
const n = (v: unknown) => Number(v ?? 0);

type TypeRow = {
  container_type_id: string;
  container_name: string;
  opening_filled: number;
  received_filled: number;
  sold_return_later: number;
  sold_permanent: number;
  sold_swap: number;
  sold_no_choice: number;
  sent_back_filled: number;
  corrections: number;
  filled_remaining: number;
  stock_sold: number;
  pos_units: number;
  inventory_variance: number;
  counted_remaining: number | null;
  count_variance: number | null;
  empties_expected: number;
  returned_good: number;
  returned_damaged: number;
  owed_from_day: number;
  owed_total: number;
  excess_pending: number;
  empties_at_shop: number;
  sent_to_warehouse: number;
  sent_unconfirmed: number;
  confirmed_by_warehouse: number;
  transfer_short: number;
  jars_sold: number;
  water_revenue: number;
  jar_revenue: number;
};
export type Revenue = {
  water_revenue: number;
  dispenser_water_revenue: number;
  jar_revenue: number;
  jars_sold: number;
  adjustments: number;
};
type Cashup = {
  reference: string;
  status: "submitted" | "queried" | "confirmed";
  expected_cash: number;
  expected_other: number;
  declared_cash: number;
  declared_other: number;
  received_cash: number | null;
  received_other: number | null;
  short_over: number;
  revenue: Revenue | null;
  cashier: string | null;
  submitted_at: string;
  accountant: string | null;
  reviewed_at: string | null;
  remittances: { number: string; method: string; amount: number }[];
};
type DayDispensers = { types: TypeRow[]; cashup: Cashup | null };

const STATUS: Record<Cashup["status"], string> = {
  submitted: "Awaiting Accounts",
  queried: "Queried by Accounts",
  confirmed: "Confirmed by Accounts",
};

const warn = (d: number | null) =>
  d == null || Math.abs(d) < 0.0005 ? "" : "font-semibold text-destructive";

export function DispenserDay({
  outletId,
  date,
  currency,
}: {
  outletId: string;
  date: string;
  currency?: string;
}) {
  useRealtimeInvalidate(
    [
      "sales",
      "rep_stock_movements",
      "jar_customer_returns",
      "jug_returns",
      "outlet_day_reconciliations",
    ],
    [["dispenser-day"]],
  );
  const q = useQuery({
    queryKey: ["dispenser-day", outletId, date],
    enabled: !!outletId && !!date,
    queryFn: async () => {
      const { data, error } = await db.rpc("shop_dispenser_day", {
        p_outlet: outletId,
        p_date: date,
      });
      if (error) throw error;
      return data as DayDispensers;
    },
  });
  const fmt = (v: number) => money(v, currency);
  if (q.isError)
    return (
      <p className="text-sm text-muted-foreground">
        Dispenser figures unavailable: {(q.error as Error).message}
      </p>
    );
  // Nothing to reconcile on a day without dispensers.
  const types = (q.data?.types ?? []).filter(
    (t) =>
      n(t.opening_filled) ||
      n(t.received_filled) ||
      n(t.pos_units) ||
      n(t.filled_remaining) ||
      n(t.returned_good) + n(t.returned_damaged) ||
      n(t.sent_to_warehouse) ||
      n(t.owed_total) ||
      n(t.empties_at_shop),
  );
  if (!q.data || types.length === 0) return null;

  const rows: {
    label: string;
    get: (t: TypeRow) => number | null;
    money?: boolean;
    tone?: boolean;
  }[] = [
    { label: "Opening filled", get: (t) => n(t.opening_filled) },
    { label: "Filled received from the Warehouse", get: (t) => n(t.received_filled) },
    { label: "Sold — water, jug to be returned", get: (t) => n(t.sold_return_later) },
    { label: "Sold — water + jug bought (permanent)", get: (t) => n(t.sold_permanent) },
    { label: "Sold — swap (empty handed in)", get: (t) => n(t.sold_swap) },
    { label: "Sold — no jar choice (older sales)", get: (t) => n(t.sold_no_choice) },
    { label: "Sent back / damaged", get: (t) => n(t.sent_back_filled) },
    { label: "Corrections", get: (t) => n(t.corrections) },
    { label: "Filled remaining", get: (t) => n(t.filled_remaining) },
    { label: "Counted at the day close", get: (t) => t.counted_remaining },
    {
      label: "Inventory variance (stock moved − POS)",
      get: (t) => n(t.inventory_variance),
      tone: true,
    },
    { label: "Count variance (counted − system)", get: (t) => t.count_variance, tone: true },
    { label: "Empties expected (today's sales)", get: (t) => n(t.empties_expected) },
    { label: "Empties returned — good", get: (t) => n(t.returned_good) },
    { label: "Empties returned — damaged", get: (t) => n(t.returned_damaged) },
    { label: "Still owed on today's sales", get: (t) => n(t.owed_from_day) },
    { label: "Still owed in all", get: (t) => n(t.owed_total) },
    { label: "Empties at the shop", get: (t) => n(t.empties_at_shop) },
    { label: "Sent to the Warehouse", get: (t) => n(t.sent_to_warehouse) },
    { label: "Awaiting the Warehouse count", get: (t) => n(t.sent_unconfirmed) },
    { label: "Confirmed by the Warehouse", get: (t) => n(t.confirmed_by_warehouse) },
    { label: "Transfer shortfall", get: (t) => n(t.transfer_short), tone: true },
    { label: "Jugs sold for good", get: (t) => n(t.jars_sold) },
    { label: "Water revenue", get: (t) => n(t.water_revenue), money: true },
    { label: "Permanent jug revenue", get: (t) => n(t.jar_revenue), money: true },
  ];
  const c = q.data.cashup;

  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex items-center gap-2 font-medium">
        <Droplets className="h-4 w-4" /> Dispenser reconciliation
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              {types.map((t) => (
                <TableHead key={t.container_type_id} className="text-right">
                  {t.container_name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows
              .filter((r) => r.tone || types.some((t) => r.get(t) != null && r.get(t) !== 0))
              .map((r) => (
                <TableRow key={r.label}>
                  <TableCell className="text-sm">{r.label}</TableCell>
                  {types.map((t) => {
                    const v = r.get(t);
                    return (
                      <TableCell
                        key={t.container_type_id}
                        className={`text-right ${r.tone ? warn(v) : ""}`}
                      >
                        {v == null ? "—" : r.money ? fmt(v) : num(v)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      {c && (
        <div className="grid gap-2 text-sm md:grid-cols-2">
          <div>
            <span className="text-muted-foreground">Cash-up </span>
            <span className="font-mono text-xs">{c.reference}</span>{" "}
            <Badge variant={c.status === "confirmed" ? "default" : "secondary"}>
              {STATUS[c.status]}
            </Badge>
            <div className="text-[11px] text-muted-foreground">
              Handed in by {c.cashier ?? "—"}, {new Date(c.submitted_at).toLocaleString()}
              {c.accountant && c.reviewed_at && (
                <>
                  {" "}
                  · {c.status === "confirmed" ? "received" : "queried"} by {c.accountant},{" "}
                  {new Date(c.reviewed_at).toLocaleString()}
                </>
              )}
            </div>
          </div>
          <div className="md:text-right">
            {c.revenue && (
              <div>
                Of the money: water {fmt(n(c.revenue.water_revenue))} · permanent jugs{" "}
                <b>{fmt(n(c.revenue.jar_revenue))}</b>
              </div>
            )}
            <div className={warn(n(c.short_over))}>
              {Math.abs(n(c.short_over)) < 0.005
                ? "Nothing short or over"
                : `${n(c.short_over) < 0 ? "Short" : "Over"} ${fmt(Math.abs(n(c.short_over)))}`}
            </div>
            {c.remittances.length > 0 && (
              <div className="text-[11px] text-muted-foreground">
                Remittance{" "}
                {c.remittances
                  .map((m) => `${m.number} (${m.method}, ${fmt(n(m.amount))})`)
                  .join(", ")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
