import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Printer } from "lucide-react";
import { localDay } from "@/lib/production-shift";
import { exportExcel } from "@/lib/export";
import { useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { generateExpenseMatrixPdf } from "@/lib/pdf";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { db } from "./shared";

// Maintenance › Expenses report laid out like the factory's "WEEKLY REPORT
// FROM OCTOBER 2026" sheet (user, 2026-11-21): every expense head down the
// side, one column per period, a TOTAL column and a TOTAL row. Weekly = the
// weeks of a month (1-7, 8-14, 15-21, 22-28, 29-end); Monthly = the months
// of a year; Yearly = one column per year; Custom = any From..To, split into
// weeks, months or years by its length.

type Mode = "weekly" | "monthly" | "yearly" | "custom";
type Bucket = { label: string; from: string; to: string };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_NAMES = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const toUtc = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;
const dmy = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return `${d}/${m}/${y}`;
};

function weeksOfMonth(y: number, m: number): Bucket[] {
  const last = daysIn(y, m);
  const out: Bucket[] = [];
  for (let start = 1; start <= last; start += 7) {
    const end = Math.min(start + 6, last);
    out.push({ label: `${start}-${end}/${m}/${y}`, from: iso(y, m, start), to: iso(y, m, end) });
    if (end === last) break;
  }
  return out;
}

function monthsBetween(from: string, to: string): Bucket[] {
  const out: Bucket[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const a = iso(y, m, 1);
    const b = iso(y, m, daysIn(y, m));
    out.push({
      label: `${MONTHS[m - 1]} ${y}`,
      from: a < from ? from : a,
      to: b > to ? to : b,
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function yearsBetween(fromY: number, toY: number, from?: string, to?: string): Bucket[] {
  const out: Bucket[] = [];
  for (let y = fromY; y <= toY; y++) {
    const a = iso(y, 1, 1);
    const b = iso(y, 12, 31);
    out.push({
      label: String(y),
      from: from && a < from ? from : a,
      to: to && b > to ? to : b,
    });
  }
  return out;
}

function customBuckets(from: string, to: string): Bucket[] {
  const days = (toUtc(to) - toUtc(from)) / DAY + 1;
  if (days <= 31) {
    const out: Bucket[] = [];
    for (let t = toUtc(from); t <= toUtc(to); t += 7 * DAY) {
      const a = fromUtc(t);
      const e = fromUtc(Math.min(t + 6 * DAY, toUtc(to)));
      out.push({ label: a === e ? dmy(a) : `${dmy(a)} - ${dmy(e)}`, from: a, to: e });
    }
    return out;
  }
  if (days <= 366) return monthsBetween(from, to);
  return yearsBetween(Number(from.slice(0, 4)), Number(to.slice(0, 4)), from, to);
}

const amt = (n: number) =>
  n ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-";

export function MaintenanceExpenseReport({
  factoryId,
  heads,
}: {
  factoryId: string | null | undefined;
  heads: readonly string[];
}) {
  const settings = useFactorySettings(factoryId ?? undefined);
  const me = useCurrentUserName();
  const today = localDay();
  const thisYear = Number(today.slice(0, 4));
  const [mode, setMode] = useState<Mode>("weekly");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(thisYear);
  const [fromYear, setFromYear] = useState(thisYear - 2);
  const [toYear, setToYear] = useState(thisYear);
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);

  const { buckets, title } = useMemo(() => {
    if (mode === "weekly") {
      const [y, m] = (month || today.slice(0, 7)).split("-").map(Number);
      return {
        buckets: weeksOfMonth(y, m),
        title: `Weekly report for ${MONTH_NAMES[m - 1]} ${y}`,
      };
    }
    if (mode === "monthly")
      return {
        buckets: monthsBetween(iso(year, 1, 1), iso(year, 12, 31)),
        title: `Monthly report for ${year}`,
      };
    if (mode === "yearly") {
      const a = Math.min(fromYear, toYear);
      const b = Math.max(fromYear, toYear);
      return {
        buckets: yearsBetween(a, b),
        title: a === b ? `Yearly report for ${a}` : `Yearly report from ${a} to ${b}`,
      };
    }
    const a = from && to && from > to ? to : from;
    const b = from && to && from > to ? from : to;
    return {
      buckets: a && b ? customBuckets(a, b) : [],
      title: `Expenses report from ${a ? dmy(a) : "—"} to ${b ? dmy(b) : "—"}`,
    };
  }, [mode, month, year, fromYear, toYear, from, to, today]);

  // Monthly columns are short: drop the year that's in the title.
  const labels = buckets.map((b) =>
    mode === "monthly" ? b.label.replace(/ \d{4}$/, "") : b.label,
  );
  const rangeFrom = buckets[0]?.from;
  const rangeTo = buckets[buckets.length - 1]?.to;

  const data = useQuery({
    queryKey: ["maintenance-expense-report", factoryId, rangeFrom, rangeTo],
    enabled: !!factoryId && !!rangeFrom && !!rangeTo,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_expenses")
        .select("category,expense_date,amount")
        .eq("factory_id", factoryId)
        .gte("expense_date", rangeFrom)
        .lte("expense_date", rangeTo);
      if (error) throw error;
      return (data ?? []) as { category: string; expense_date: string; amount: number }[];
    },
  });

  // Every head (like the sheet), then any other head that has spending.
  const matrix = useMemo(() => {
    const sums = new Map<string, number[]>();
    const extra: string[] = [];
    const row = (h: string) => {
      let r = sums.get(h);
      if (!r) {
        r = buckets.map(() => 0);
        sums.set(h, r);
        if (!heads.includes(h)) extra.push(h);
      }
      return r;
    };
    heads.forEach(row);
    for (const e of data.data ?? []) {
      const i = buckets.findIndex((b) => e.expense_date >= b.from && e.expense_date <= b.to);
      if (i >= 0) row(e.category)[i] += Number(e.amount);
    }
    const rows = [...heads, ...extra.sort()].map((h) => {
      const vals = sums.get(h)!;
      return { head: h, vals, total: vals.reduce((s, v) => s + v, 0) };
    });
    const colTotals = buckets.map((_, i) => rows.reduce((s, r) => s + r.vals[i], 0));
    return { rows, colTotals, grand: colTotals.reduce((s, v) => s + v, 0) };
  }, [data.data, buckets, heads]);

  const subtitle = [
    rangeFrom && rangeTo ? `Period: ${dmy(rangeFrom)} to ${dmy(rangeTo)}` : "",
  ].filter(Boolean);

  const print = () =>
    generateExpenseMatrixPdf({
      company: settings.data,
      title,
      subtitle,
      columns: labels,
      rows: matrix.rows.map((r) => ({ head: r.head, values: r.vals, total: r.total })),
      colTotals: matrix.colTotals,
      grand: matrix.grand,
      printedBy: me.data,
      filename: title.toLowerCase().replace(/\s+/g, "-"),
    });

  const excel = () => {
    const cols = [
      { key: "head", label: "Expense head" },
      ...labels.map((l, i) => ({ key: `c${i}`, label: l })),
      { key: "total", label: "Total" },
    ];
    const line = (head: string, vals: number[], total: number) => ({
      head,
      ...Object.fromEntries(vals.map((v, i) => [`c${i}`, v])),
      total,
    });
    exportExcel(title.toLowerCase().replace(/\s+/g, "-"), cols, [
      ...matrix.rows.map((r) => line(r.head, r.vals, r.total)),
      line("TOTAL", matrix.colTotals, matrix.grand),
    ]);
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="space-y-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Expense report</CardTitle>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={!buckets.length || data.isLoading}
              onClick={print}
            >
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button
              size="icon"
              variant="outline"
              title="Excel"
              className="h-9 w-9"
              disabled={!buckets.length || data.isLoading}
              onClick={excel}
            >
              <FileSpreadsheet className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Report</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
                <SelectItem value="custom">Custom (from – to)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === "weekly" && (
            <div className="space-y-1">
              <Label className="text-xs">Month</Label>
              <Input
                type="month"
                value={month}
                max={today.slice(0, 7)}
                onChange={(e) => setMonth(e.target.value)}
                className="w-44"
              />
            </div>
          )}
          {mode === "monthly" && (
            <div className="space-y-1">
              <Label className="text-xs">Year</Label>
              <Input
                type="number"
                value={year}
                min={2000}
                max={thisYear}
                onChange={(e) => setYear(Number(e.target.value) || thisYear)}
                className="w-28"
              />
            </div>
          )}
          {mode === "yearly" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">From year</Label>
                <Input
                  type="number"
                  value={fromYear}
                  min={2000}
                  max={thisYear}
                  onChange={(e) => setFromYear(Number(e.target.value) || thisYear)}
                  className="w-28"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To year</Label>
                <Input
                  type="number"
                  value={toYear}
                  min={2000}
                  max={thisYear}
                  onChange={(e) => setToYear(Number(e.target.value) || thisYear)}
                  className="w-28"
                />
              </div>
            </>
          )}
          {mode === "custom" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                  className="w-40"
                />
              </div>
            </>
          )}
        </div>
        <div className="text-center text-sm font-semibold uppercase">{title}</div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Expense head</TableHead>
              {labels.map((l) => (
                <TableHead key={l} className="whitespace-nowrap text-right">
                  {l}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matrix.rows.map((r) => (
              <TableRow key={r.head}>
                <TableCell className="whitespace-nowrap font-medium">{r.head}</TableCell>
                {r.vals.map((v, i) => (
                  <TableCell key={i} className="whitespace-nowrap text-right">
                    {amt(v)}
                  </TableCell>
                ))}
                <TableCell className="whitespace-nowrap text-right font-semibold">
                  {amt(r.total)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/50 font-bold">
              <TableCell>TOTAL</TableCell>
              {matrix.colTotals.map((v, i) => (
                <TableCell key={i} className="whitespace-nowrap text-right">
                  {amt(v)}
                </TableCell>
              ))}
              <TableCell className="whitespace-nowrap text-right">{amt(matrix.grand)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
