import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { rpc } from "@/components/preform/api";
import { DatePicker } from "@/components/shared/date-picker";
import { ReportActions } from "@/components/shared/report-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { num } from "@/lib/format";

// Jugs sold in a month (user, 2026-11-16: "a place where you can get the total
// of the jugs we sold for the month ... under report tab", on Quality Control
// and Warehouse). One screen for both pages, from jugs_sold_report
// (20261116110000): Jug + Water (the buyer kept the jug) and Empty Jug, counted
// once where the jug leaves -- marketer postings (incl. Jug + Water marked at
// the return) less returns, Retail Shop POS sales, Warehouse sales less
// returns. Quantities only, no money.

type Row = {
  sold_on: string;
  buyer_kind: "rep" | "shop" | "customer" | "walk_in";
  buyer_id: string | null;
  buyer_name: string;
  buyer_code: string | null;
  jug_water: number;
  empty_jug: number;
};

const KIND: Record<Row["buyer_kind"], string> = {
  rep: "Marketer",
  shop: "Retail Shop",
  customer: "Distributor / Office Delivery",
  walk_in: "Walk-in",
};
const ORDER: Row["buyer_kind"][] = ["rep", "customer", "walk_in", "shop"];

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

export function JugsSoldReport({ factoryId, place }: { factoryId: string; place: string }) {
  const today = lagosToday();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [view, setView] = useState<"buyer" | "day">("buyer");
  const ok = !!from && !!to && from <= to;
  const month =
    from.slice(0, 7) === to.slice(0, 7) && from === monthStart(from) ? from.slice(0, 7) : "";

  const pickMonth = (ym: string) => {
    if (!ym) return;
    const end = monthEnd(ym);
    setFrom(`${ym}-01`);
    setTo(end > today ? today : end);
  };

  const q = useQuery({
    queryKey: ["jugs-sold-report", factoryId, from, to],
    enabled: ok,
    queryFn: () =>
      rpc<Row[]>("jugs_sold_report", { p_factory: factoryId, p_from: from, p_to: to }).then(
        (rows) =>
          (rows ?? []).map((r) => ({
            ...r,
            jug_water: Number(r.jug_water ?? 0),
            empty_jug: Number(r.empty_jug ?? 0),
          })),
      ),
  });
  const rows = useMemo(() => q.data ?? [], [q.data]);

  const totals = useMemo(() => {
    const t = { jw: 0, ej: 0, byKind: {} as Record<string, number> };
    for (const r of rows) {
      t.jw += r.jug_water;
      t.ej += r.empty_jug;
      t.byKind[r.buyer_kind] = (t.byKind[r.buyer_kind] ?? 0) + r.jug_water + r.empty_jug;
    }
    return t;
  }, [rows]);

  // Per buyer: the period added up; per day: every buyer's day.
  const lines = useMemo(() => {
    if (view === "day")
      return rows
        .filter((r) => r.jug_water || r.empty_jug)
        .map((r) => ({ ...r, key: `${r.sold_on}|${r.buyer_kind}|${r.buyer_id}|${r.buyer_name}` }));
    const m = new Map<string, Row & { key: string }>();
    for (const r of rows) {
      const key = `${r.buyer_kind}|${r.buyer_id ?? r.buyer_name}`;
      const g = m.get(key) ?? { ...r, key, jug_water: 0, empty_jug: 0 };
      g.jug_water += r.jug_water;
      g.empty_jug += r.empty_jug;
      m.set(key, g);
    }
    return [...m.values()]
      .filter((r) => r.jug_water || r.empty_jug)
      .sort(
        (a, b) =>
          ORDER.indexOf(a.buyer_kind) - ORDER.indexOf(b.buyer_kind) ||
          b.jug_water + b.empty_jug - (a.jug_water + a.empty_jug) ||
          a.buyer_name.localeCompare(b.buyer_name),
      );
  }, [rows, view]);

  const name = (r: Row) => (r.buyer_code ? `${r.buyer_name} (${r.buyer_code})` : r.buyer_name);
  const period = month ? monthLabel(month) : `${from} to ${to}`;
  const status = !ok
    ? "The To date is before the From date."
    : q.isLoading
      ? "Loading…"
      : q.error
        ? /could not find the function/i.test((q.error as Error).message)
          ? "The Jugs sold report is not in the database yet -- run supabase/migrations/20261116110000_jugs_sold_report.sql in the SQL Editor."
          : (q.error as Error).message
        : lines.length === 0
          ? "No jugs sold in this period."
          : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor={`jugs-sold-month-${place}`} className="text-xs">
            Month
          </Label>
          <Input
            id={`jugs-sold-month-${place}`}
            type="month"
            className="w-44"
            value={month}
            max={today.slice(0, 7)}
            onChange={(e) => pickMonth(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs">From</Label>
          <DatePicker value={from} max={to} onChange={setFrom} />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <DatePicker value={to} min={from} max={today} onChange={setTo} />
        </div>
        <div>
          <Label className="text-xs">Show</Label>
          <div className="flex rounded-md border p-0.5">
            {(
              [
                ["buyer", "Per buyer"],
                ["day", "Day by day"],
              ] as const
            ).map(([v, text]) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? "default" : "ghost"}
                className="h-8 px-4"
                onClick={() => setView(v)}
              >
                {text}
              </Button>
            ))}
          </div>
        </div>
        <div className="ml-auto">
          <ReportActions
            title={`Jugs Sold — ${period}`}
            fileName={`jugs-sold-${from}-to-${to}`}
            columns={[
              { key: "sn", label: "S/N" },
              ...(view === "day" ? [{ key: "date", label: "Date" }] : []),
              { key: "name", label: "Buyer" },
              { key: "kind", label: "Type" },
              { key: "jw", label: "Jug + Water" },
              { key: "ej", label: "Empty Jug" },
              { key: "total", label: "Jugs Sold" },
            ]}
            rows={
              lines.length
                ? [
                    ...lines.map((r, i) => ({
                      sn: i + 1,
                      date: r.sold_on,
                      name: name(r),
                      kind: KIND[r.buyer_kind],
                      jw: num(r.jug_water),
                      ej: num(r.empty_jug),
                      total: num(r.jug_water + r.empty_jug),
                    })),
                    {
                      sn: "",
                      date: "",
                      name: "Total",
                      kind: "",
                      jw: num(totals.jw),
                      ej: num(totals.ej),
                      total: num(totals.jw + totals.ej),
                    },
                  ]
                : []
            }
            subtitle={[`${place} — ${period}`]}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total jugs sold" value={totals.jw + totals.ej} strong period={period} />
        <Stat label="Jug + Water (customer kept the jug)" value={totals.jw} period={period} />
        <Stat label="Empty Jug sold" value={totals.ej} period={period} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        {ORDER.map((k) => (
          <span key={k}>
            {KIND[k]}:{" "}
            <span className="font-medium text-foreground">{num(totals.byKind[k] ?? 0)}</span>
          </span>
        ))}
      </div>

      {status ? (
        <p className={`text-sm ${q.error || !ok ? "text-destructive" : "text-muted-foreground"}`}>
          {status}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                {view === "day" && <TableHead>Date</TableHead>}
                <TableHead>Buyer</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Jug + Water</TableHead>
                <TableHead className="text-right">Empty Jug</TableHead>
                <TableHead className="text-right">Jugs Sold</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((r, i) => (
                <TableRow key={r.key}>
                  <TableCell>{i + 1}</TableCell>
                  {view === "day" && (
                    <TableCell className="whitespace-nowrap">{r.sold_on}</TableCell>
                  )}
                  <TableCell className="font-medium">{name(r)}</TableCell>
                  <TableCell className="text-muted-foreground">{KIND[r.buyer_kind]}</TableCell>
                  <TableCell className="text-right">{num(r.jug_water)}</TableCell>
                  <TableCell className="text-right">{num(r.empty_jug)}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {num(r.jug_water + r.empty_jug)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell />
                {view === "day" && <TableCell />}
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell />
                <TableCell className="text-right font-semibold">{num(totals.jw)}</TableCell>
                <TableCell className="text-right font-semibold">{num(totals.ej)}</TableCell>
                <TableCell className="text-right font-semibold">
                  {num(totals.jw + totals.ej)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        A jug counts as sold when it leaves with its buyer for good: Jug + Water (sold as Jug +
        Water, and the Dispenser Water the Warehouse marks as Jug + Water at a marketer&apos;s
        return) and Empty Jug. Marketers count from their postings, less what they bring back
        unsold; their own customers are not counted again. Dispenser Water with the empty handed
        back is not a jug sold.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  period,
  strong,
}: {
  label: string;
  value: number;
  period: string;
  strong?: boolean;
}) {
  return (
    <Card className={`rounded-2xl ${strong ? "border-primary" : ""}`}>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 font-semibold ${strong ? "text-3xl text-primary" : "text-2xl"}`}>
          {num(value)}
        </div>
        <div className="text-xs text-muted-foreground">{period}</div>
      </CardContent>
    </Card>
  );
}
