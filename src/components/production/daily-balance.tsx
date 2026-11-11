import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, Download, FileDown, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useFactorySettings } from "@/lib/use-factory";
import { useMyProductMatcher } from "@/lib/product-rules";
import { addDays, localDay, SHIFT_LABEL, type ProductionShift } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { generateReportPdf } from "@/lib/pdf";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Daily and shift opening / closing balances of the production hall
// (production_daily_balance, 20261111090000). Worked out by the database
// from the ledger -- batches, releases (issues), damages, clearances and
// opening counts -- so nothing is typed in twice and a correction to an
// earlier day flows into every later one:
//
//   Day shift (morning)     opens at the previous day's final closing
//   Night shift (afternoon) opens at the Day shift's closing; it runs on past
//                           6 p.m. and stays on its own production day
//   Over-Time (Sunday)      opens at the Night shift's closing
//   closing = opening + produced - damaged - issued - cleared
//   the last closing of a day is the next day's opening.

export type BalanceRow = {
  product_id: string;
  product_name: string;
  unit: string | null;
  production_date: string;
  shift: ProductionShift;
  prev_closing: number;
  opening: number;
  opening_reset: boolean;
  produced: number;
  damaged: number;
  issued: number;
  cleared: number;
  closing: number;
  operators: string | null;
  batches: number;
  releases: number;
};

const SHIFTS: ProductionShift[] = ["day", "night", "overtime"];
export const SHIFT_LONG: Record<ProductionShift, string> = {
  day: "Day shift (morning)",
  night: "Night shift (afternoon / late)",
  overtime: "Over-Time",
};

export function useDailyBalance(
  factoryId: string | undefined,
  productId: string | null,
  from: string,
  to: string,
) {
  useRealtimeInvalidate(["production", "production_releases"], [["production-daily-balance"]]);
  return useQuery({
    queryKey: ["production-daily-balance", factoryId, productId, from, to],
    enabled: !!factoryId && !!from && !!to && from <= to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "production_daily_balance" as never,
        {
          p_factory: factoryId,
          p_product: productId,
          p_from: from,
          p_to: to,
        } as never,
      );
      if (error) throw error;
      return ((data ?? []) as BalanceRow[]).map((r) => ({
        ...r,
        prev_closing: Number(r.prev_closing),
        opening: Number(r.opening),
        produced: Number(r.produced),
        damaged: Number(r.damaged),
        issued: Number(r.issued),
        cleared: Number(r.cleared),
        closing: Number(r.closing),
      }));
    },
  });
}

export type DayRow = {
  product_id: string;
  product_name: string;
  unit: string | null;
  date: string;
  prev_closing: number;
  opening: number;
  opening_reset: boolean;
  produced: number;
  damages: number;
  issued: number;
  available: number;
  closing: number;
  next_opening: number | null;
  shifts: Partial<Record<ProductionShift, BalanceRow>>;
};

// Shift rows -> one row per product per day. The next day's opening comes
// from the next day's row (it differs only when an opening count resets it).
export function toDays(rows: BalanceRow[]): DayRow[] {
  const byKey = new Map<string, DayRow>();
  for (const r of rows) {
    const key = `${r.product_id}|${r.production_date}`;
    let d = byKey.get(key);
    if (!d) {
      d = {
        product_id: r.product_id,
        product_name: r.product_name,
        unit: r.unit,
        date: r.production_date,
        prev_closing: r.prev_closing,
        opening: r.opening,
        opening_reset: r.opening_reset,
        produced: 0,
        damages: 0,
        issued: 0,
        available: 0,
        closing: r.closing,
        next_opening: null,
        shifts: {},
      };
      byKey.set(key, d);
    }
    d.shifts[r.shift] = r;
    d.produced += r.produced;
    d.damages += r.damaged + r.cleared;
    d.issued += r.issued;
    d.closing = r.closing; // rows come Day, Night, Over-Time
  }
  const days = [...byKey.values()].sort(
    (a, b) => a.product_name.localeCompare(b.product_name) || a.date.localeCompare(b.date),
  );
  for (const d of days) {
    d.available = d.opening + d.produced;
    const next = byKey.get(`${d.product_id}|${addDays(d.date, 1)}`);
    d.next_opening = next ? next.opening : null;
  }
  return days;
}

const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function Stat({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: number;
  unit?: string | null;
  hint?: string;
  tone?: "strong" | "muted";
}) {
  return (
    <div className={`rounded-xl border p-3 ${tone === "strong" ? "bg-primary/5" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${value < 0 ? "text-destructive" : ""}`}>
        {num(value)}{" "}
        {unit && <span className="text-sm font-normal text-muted-foreground">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

// Production page: today's (or a chosen day's) opening, each shift and the
// closing that opens tomorrow, for one of the person's products, with the
// last seven days underneath.
export function DailyBalanceCard({ factoryId }: { factoryId: string }) {
  const [date, setDate] = useState(localDay());
  const [picked, setPicked] = useState("");
  const from = addDays(date, -6);
  // One extra day so the chosen day's "next day opening" is known.
  const all = useDailyBalance(factoryId, null, from, addDays(date, 1));
  const mine = useMyProductMatcher();

  const products = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of all.data ?? []) if (mine(r.product_name)) m.set(r.product_id, r.product_name);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all.data, mine]);
  // Sachet Water first when the person handles it (the brief's product).
  const productId =
    (picked && products.some((p) => p.id === picked) ? picked : "") ||
    products.find((p) => /sachet|satchet/i.test(p.name))?.id ||
    products[0]?.id ||
    "";

  const days = useMemo(
    () => toDays((all.data ?? []).filter((r) => r.product_id === productId)),
    [all.data, productId],
  );
  const day = days.find((d) => d.date === date);
  const week = days.filter((d) => d.date <= date).reverse();
  const unit = day?.unit ?? null;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" /> Daily opening &amp; closing balance
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Yesterday&apos;s closing opens today automatically. The Day shift adds to it, the Night
            shift (running past 6 p.m.) continues from the Day shift&apos;s closing, and the final
            closing opens tomorrow.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">Product</Label>
            <Select value={productId} onValueChange={setPicked}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="No products yet" />
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Production day</Label>
            <Input
              type="date"
              value={date}
              max={localDay()}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {all.isError ? (
          <p className="text-sm text-destructive">{(all.error as Error).message}</p>
        ) : !day ? (
          <p className="text-sm text-muted-foreground">
            {all.isLoading ? "Loading…" : "Nothing recorded for your products yet."}
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Previous day closing" value={day.prev_closing} unit={unit} />
              <Stat
                label="Today's opening balance"
                value={day.opening}
                unit={unit}
                hint={
                  day.opening_reset
                    ? "Reset to the opening count recorded for this day"
                    : "Carried forward automatically"
                }
              />
              <Stat label="Total daily production" value={day.produced} unit={unit} />
              <Stat
                label="Total available stock"
                value={day.available}
                unit={unit}
                hint="Opening + production"
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {SHIFTS.filter(
                (s) =>
                  s !== "overtime" ||
                  (day.shifts.overtime &&
                    (day.shifts.overtime.produced ||
                      day.shifts.overtime.issued ||
                      day.shifts.overtime.damaged ||
                      day.shifts.overtime.cleared)),
              ).map((s) => {
                const r = day.shifts[s];
                if (!r) return null;
                return (
                  <div key={s} className="rounded-xl border p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-medium">{SHIFT_LONG[s]}</span>
                      {r.operators && (
                        <span className="text-xs text-muted-foreground">by {r.operators}</span>
                      )}
                    </div>
                    <div className="grid grid-cols-5 gap-2 text-sm">
                      {(
                        [
                          ["Opening", r.opening],
                          ["Production", r.produced],
                          ["Issues", r.issued],
                          ["Damages", r.damaged + r.cleared],
                          ["Closing", r.closing],
                        ] as const
                      ).map(([l, v]) => (
                        <div key={l}>
                          <div className="text-[11px] text-muted-foreground">{l}</div>
                          <div
                            className={`${l === "Closing" ? "font-semibold" : ""} ${v < 0 ? "text-destructive" : ""}`}
                          >
                            {num(v)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Final daily closing balance"
                value={day.closing}
                unit={unit}
                tone="strong"
              />
              <Stat
                label="Next day opening balance"
                value={day.next_opening ?? day.closing}
                unit={unit}
                hint={`Opens ${fmtDay(addDays(date, 1))}`}
                tone="strong"
              />
            </div>
          </>
        )}

        {week.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Production</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Issues</TableHead>
                  <TableHead className="text-right">Damages</TableHead>
                  <TableHead className="text-right">Closing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {week.map((d) => (
                  <Fragment key={d.date}>
                    {SHIFTS.map((s) => d.shifts[s])
                      .filter(
                        (r): r is BalanceRow =>
                          !!r &&
                          (r.shift !== "overtime" ||
                            !!(r.produced || r.issued || r.damaged || r.cleared)),
                      )
                      .map((r, i) => (
                        <TableRow key={r.shift} className={i === 0 ? "border-t-2" : ""}>
                          <TableCell className="whitespace-nowrap">
                            {i === 0 ? fmtDay(d.date) : ""}
                          </TableCell>
                          <TableCell>{SHIFT_LABEL[r.shift]}</TableCell>
                          <TableCell className="text-right">
                            {num(r.opening)}
                            {r.opening_reset && (
                              <Badge variant="outline" className="ml-1">
                                count
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{num(r.produced)}</TableCell>
                          <TableCell className="text-right">
                            {num(r.opening + r.produced)}
                          </TableCell>
                          <TableCell className="text-right">{num(r.issued)}</TableCell>
                          <TableCell className="text-right">{num(r.damaged + r.cleared)}</TableCell>
                          <TableCell
                            className={`text-right font-semibold ${r.closing < 0 ? "text-destructive" : ""}`}
                          >
                            {num(r.closing)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type ReportKind =
  "daily" | "shift-day" | "shift-night" | "balances" | "carry" | "issues" | "history";
const REPORTS: Record<ReportKind, string> = {
  daily: "Daily Production Report",
  "shift-day": "Day (Morning) Shift Report",
  "shift-night": "Night (Afternoon) Shift Report",
  balances: "Opening & Closing Balance Report",
  carry: "Carry-Forward Report",
  issues: "Issues & Damages Report",
  history: "Production History by Date",
};

type Col = { key: string; label: string; num?: boolean };

// Production Reports page: the seven balance reports over the page's date
// range, filtered by product, shift and operator; CSV and PDF.
export function DailyBalanceReports({
  factoryId,
  from,
  to,
}: {
  factoryId: string;
  from: string;
  to: string;
}) {
  const settings = useFactorySettings(factoryId);
  const [kind, setKind] = useState<ReportKind>("daily");
  const [product, setProduct] = useState("all");
  const [shift, setShift] = useState<"all" | ProductionShift>("all");
  const [operator, setOperator] = useState("");
  const tooLong =
    (new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 864e5 > 400;
  const q = useDailyBalance(factoryId, null, from, tooLong ? from : addDays(to, 1));
  const mine = useMyProductMatcher();

  const rowsAll = useMemo(() => (q.data ?? []).filter((r) => mine(r.product_name)), [q.data, mine]);
  const products = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rowsAll) m.set(r.product_id, r.product_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rowsAll]);
  const forProduct = rowsAll.filter((r) => product === "all" || r.product_id === product);
  const days = toDays(forProduct).filter((d) => d.date <= to);
  const op = operator.trim().toLowerCase();
  const shiftRows = forProduct.filter(
    (r) =>
      r.production_date <= to &&
      (!op || (r.operators ?? "").toLowerCase().includes(op)) &&
      (kind === "shift-day"
        ? r.shift === "day"
        : kind === "shift-night"
          ? r.shift === "night"
          : shift === "all" || r.shift === shift),
  );
  const isShiftReport =
    kind === "shift-day" || kind === "shift-night" || kind === "issues" || kind === "history";

  const { cols, rows } = useMemo((): { cols: Col[]; rows: Record<string, unknown>[] } => {
    const base: Col[] = [
      { key: "date", label: "Date" },
      { key: "product", label: "Product" },
    ];
    if (kind === "daily")
      return {
        cols: [
          ...base,
          { key: "prev", label: "Prev. day closing", num: true },
          { key: "opening", label: "Opening", num: true },
          { key: "produced", label: "Production", num: true },
          { key: "available", label: "Available", num: true },
          { key: "issued", label: "Issues", num: true },
          { key: "damages", label: "Damages", num: true },
          { key: "closing", label: "Final closing", num: true },
          { key: "next", label: "Next day opening", num: true },
        ],
        rows: days.map((d) => ({
          date: d.date,
          product: d.product_name,
          prev: d.prev_closing,
          opening: d.opening,
          produced: d.produced,
          available: d.available,
          issued: d.issued,
          damages: d.damages,
          closing: d.closing,
          next: d.next_opening ?? d.closing,
        })),
      };
    if (kind === "balances")
      return {
        cols: [
          ...base,
          { key: "opening", label: "Opening", num: true },
          { key: "day", label: "Day closing", num: true },
          { key: "night", label: "Night closing", num: true },
          { key: "closing", label: "Final closing", num: true },
          { key: "next", label: "Next day opening", num: true },
        ],
        rows: days.map((d) => ({
          date: d.date,
          product: d.product_name,
          opening: d.opening,
          day: d.shifts.day?.closing ?? 0,
          night: d.shifts.night?.closing ?? 0,
          closing: d.closing,
          next: d.next_opening ?? d.closing,
        })),
      };
    if (kind === "carry")
      return {
        cols: [
          ...base,
          { key: "closing", label: "Final closing", num: true },
          { key: "to", label: "Carried to" },
          { key: "next", label: "Opening there", num: true },
          { key: "check", label: "Check" },
        ],
        rows: days.map((d) => {
          const next = d.next_opening ?? d.closing;
          return {
            date: d.date,
            product: d.product_name,
            closing: d.closing,
            to: addDays(d.date, 1),
            next,
            check: next === d.closing ? "Carried forward" : "Reset by opening count",
          };
        }),
      };
    if (kind === "issues")
      return {
        cols: [
          ...base,
          { key: "shift", label: "Shift" },
          { key: "issued", label: "Issues (released)", num: true },
          { key: "releases", label: "Releases", num: true },
          { key: "damaged", label: "Damaged", num: true },
          { key: "cleared", label: "Cleared", num: true },
          { key: "closing", label: "Shift closing", num: true },
        ],
        rows: shiftRows
          .filter((r) => r.issued || r.damaged || r.cleared)
          .map((r) => ({
            date: r.production_date,
            product: r.product_name,
            shift: SHIFT_LABEL[r.shift],
            issued: r.issued,
            releases: r.releases,
            damaged: r.damaged,
            cleared: r.cleared,
            closing: r.closing,
          })),
      };
    if (kind === "history")
      return {
        cols: [
          ...base,
          { key: "shift", label: "Shift" },
          { key: "operators", label: "Operator(s)" },
          { key: "batches", label: "Batches", num: true },
          { key: "produced", label: "Production", num: true },
          { key: "damaged", label: "Damaged", num: true },
        ],
        rows: shiftRows
          .filter((r) => r.batches > 0)
          .map((r) => ({
            date: r.production_date,
            product: r.product_name,
            shift: SHIFT_LABEL[r.shift],
            operators: r.operators ?? "—",
            batches: r.batches,
            produced: r.produced,
            damaged: r.damaged,
          })),
      };
    // Day / Night shift reports.
    return {
      cols: [
        ...base,
        { key: "operators", label: "Operator(s)" },
        { key: "opening", label: "Opening", num: true },
        { key: "produced", label: "Production", num: true },
        { key: "available", label: "Available", num: true },
        { key: "issued", label: "Issues", num: true },
        { key: "damages", label: "Damages", num: true },
        { key: "closing", label: "Closing", num: true },
      ],
      rows: shiftRows.map((r) => ({
        date: r.production_date,
        product: r.product_name,
        operators: r.operators ?? "—",
        opening: r.opening,
        produced: r.produced,
        available: r.opening + r.produced,
        issued: r.issued,
        damages: r.damaged + r.cleared,
        closing: r.closing,
      })),
    };
  }, [kind, days, shiftRows]);

  const title = REPORTS[kind];
  const subtitle = [
    `${from} to ${to}`,
    product === "all" ? "All your products" : (products.find(([id]) => id === product)?.[1] ?? ""),
    ...(isShiftReport && op ? [`Operator: ${operator.trim()}`] : []),
  ];
  const fmt = (c: Col, v: unknown) => (c.num ? num(Number(v)) : String(v ?? ""));
  const pdf = (action: "download" | "print") =>
    generateReportPdf(
      title,
      cols,
      rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, fmt(c, r[c.key])]))),
      action,
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      subtitle,
    );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Opening, production &amp; closing reports</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Each day opens at the previous day&apos;s final closing; each shift opens at the
              previous shift&apos;s closing. Closing = opening + production − issues − damages.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={!rows.length}
              onClick={() => exportCsv(`${kind}-${from}-to-${to}`, cols, rows)}
            >
              <Download className="h-4 w-4" /> CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={!rows.length}
              onClick={() => pdf("print")}
            >
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={!rows.length}
              onClick={() => pdf("download")}
            >
              <FileDown className="h-4 w-4" /> PDF
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">Report</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ReportKind)}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REPORTS) as ReportKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {REPORTS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Product</Label>
            <Select value={product} onValueChange={setProduct}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All my products</SelectItem>
                {products.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(kind === "issues" || kind === "history") && (
            <div>
              <Label className="text-xs">Shift</Label>
              <Select value={shift} onValueChange={(v) => setShift(v as typeof shift)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All shifts</SelectItem>
                  {SHIFTS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SHIFT_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {isShiftReport && (
            <div>
              <Label className="text-xs">Operator</Label>
              <Input
                className="w-44"
                placeholder="Any operator"
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
              />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {tooLong ? (
          <p className="text-sm text-muted-foreground">Pick a range of at most 400 days.</p>
        ) : q.isError ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {cols.map((c) => (
                  <TableHead key={c.key} className={c.num ? "text-right" : ""}>
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  {cols.map((c) => (
                    <TableCell
                      key={c.key}
                      className={`${c.num ? "text-right" : ""} ${c.key === "date" ? "whitespace-nowrap" : ""} ${
                        c.key === "closing" ? "font-semibold" : ""
                      }`}
                    >
                      {c.key === "to" ? (
                        <span className="inline-flex items-center gap-1">
                          <ArrowRight className="h-3 w-3" /> {String(r.to)}
                        </span>
                      ) : (
                        fmt(c, r[c.key])
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={cols.length}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {q.isLoading ? "Loading…" : "Nothing for this selection."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
