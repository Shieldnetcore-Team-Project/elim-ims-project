import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FileDown, FileSpreadsheet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { exportCsv, exportExcel, type ReportColumn } from "@/lib/export";
import { money } from "@/lib/format";
import { postedSalesRows } from "@/lib/metric-queries";
import { useRealtimeInvalidate } from "@/lib/realtime";
import {
  MONTH_NAMES,
  REVENUE_SALE_COLS,
  buildMonthlyAccumulated,
  changeVsPrior,
  lastMonthOf,
  monthLabel,
} from "@/lib/sales-revenue-report";

// Which months of the year to show (0-based, inclusive). The accumulated
// figure always runs from January, so a quarter still shows the year-to-date
// total at each of its months.
const PERIODS = [
  { key: "year", label: "Whole year", from: 0, to: 11 },
  { key: "h1", label: "First half", from: 0, to: 5 },
  { key: "h2", label: "Second half", from: 6, to: 11 },
  { key: "q1", label: "Q1 (Jan–Mar)", from: 0, to: 2 },
  { key: "q2", label: "Q2 (Apr–Jun)", from: 3, to: 5 },
  { key: "q3", label: "Q3 (Jul–Sep)", from: 6, to: 8 },
  { key: "q4", label: "Q4 (Oct–Dec)", from: 9, to: 11 },
] as const;

const COLUMNS: ReportColumn[] = [
  { key: "month", label: "Month" },
  { key: "invoices", label: "Approved Sales" },
  { key: "revenue", label: "Sales Revenue" },
  { key: "change", label: "vs Prior Month" },
  { key: "accumulated", label: "Accumulated" },
];

const monthIndex = (key: string) => Number(key.slice(5, 7)) - 1;
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

// Sales revenue month by month for a year, with the accumulated (year-to-date)
// total: bars for each month's revenue, a line for the running total. Same
// posted-sales rule as every other revenue figure. Lives in its own tab on the
// Finance overview.
export function MonthlySalesCard({ factoryId }: { factoryId: string }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [periodKey, setPeriodKey] = useState<(typeof PERIODS)[number]["key"]>("year");
  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[0];
  useRealtimeInvalidate(["sales"], [["monthly-sales"]]);

  const monthly = useQuery({
    queryKey: ["monthly-sales", factoryId, year],
    enabled: !!factoryId,
    queryFn: async () =>
      buildMonthlyAccumulated(
        await postedSalesRows(factoryId, REVENUE_SALE_COLS, `${year}-01-01`, `${year}-12-31`),
        year,
        lastMonthOf(year),
      ),
  });

  const all = monthly.data?.lines ?? [];
  const rows = all
    .map((l, i) => ({ ...l, change: changeVsPrior(l.revenue, all[i - 1]?.revenue) }))
    .filter((l) => monthIndex(l.key) >= period.from && monthIndex(l.key) <= period.to);
  const invoices = rows.reduce((n, l) => n + l.invoices, 0);
  const revenue = rows.reduce((n, l) => n + l.revenue, 0);
  const best = rows.reduce<(typeof rows)[number] | null>(
    (b, l) => (l.revenue > 0 && (!b || l.revenue > b.revenue) ? l : b),
    null,
  );
  const last = rows.at(-1);

  // Every month of the period on the axis; months still to come stay empty.
  const chart = Array.from({ length: period.to - period.from + 1 }, (_, i) => {
    const m = period.from + i;
    const line = all.find((l) => monthIndex(l.key) === m);
    return {
      month: MONTH_NAMES[m].slice(0, 3),
      revenue: line?.revenue ?? null,
      accumulated: line?.accumulated ?? null,
    };
  });

  const exportRows = () => [
    ...rows.map((l) => ({
      month: monthLabel(l.key),
      invoices: l.invoices,
      revenue: l.revenue,
      change: pct(l.change),
      accumulated: l.accumulated,
    })),
    {
      month: "TOTAL",
      invoices,
      revenue: Math.round(revenue * 100) / 100,
      change: "",
      accumulated: last?.accumulated ?? 0,
    },
  ];
  const fileName = `monthly-accumulated-sales-${year}${period.key === "year" ? "" : `-${period.key}`}`;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Monthly Accumulated Sales · {year}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Approved sales only (excludes PR and deleted sales), by sale date. The accumulated
            column is the running total from January.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 5 }, (_, i) => thisYear - i).map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={periodKey} onValueChange={(v) => setPeriodKey(v as typeof periodKey)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={rows.length === 0}
            onClick={() => exportCsv(fileName, COLUMNS, exportRows())}
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={rows.length === 0}
            onClick={() => exportExcel(fileName, COLUMNS, exportRows())}
          >
            <FileSpreadsheet className="h-4 w-4" /> Excel
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {monthly.error ? (
          <p className="text-sm text-destructive">Could not load sales for {year}.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat
                label={
                  period.key === "year" || !last
                    ? `Accumulated for ${year}`
                    : `Accumulated to end of ${MONTH_NAMES[monthIndex(last.key)]}`
                }
                value={money(last?.accumulated ?? 0)}
              />
              <Stat label="Approved sales" value={String(invoices)} />
              <Stat
                label="Best month"
                value={best ? `${MONTH_NAMES[monthIndex(best.key)]} · ${money(best.revenue)}` : "—"}
              />
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="month" stroke="var(--color-muted-foreground)" fontSize={12} />
                  <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                    }}
                    formatter={(v: number) => money(v)}
                  />
                  <Legend />
                  <Bar
                    dataKey="revenue"
                    name="Monthly revenue"
                    fill="var(--color-primary)"
                    radius={[4, 4, 0, 0]}
                  />
                  <Line
                    type="monotone"
                    dataKey="accumulated"
                    name="Accumulated"
                    stroke="var(--color-success)"
                    strokeWidth={2.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Approved Sales</TableHead>
                    <TableHead className="text-right">Sales Revenue</TableHead>
                    <TableHead className="text-right">vs Prior Month</TableHead>
                    <TableHead className="text-right">Accumulated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((l) => (
                    <TableRow key={l.key}>
                      <TableCell>{monthLabel(l.key).replace(/^(\w{3})\w*/, "$1")}</TableCell>
                      <TableCell className="text-right">{l.invoices}</TableCell>
                      <TableCell className="text-right">{money(l.revenue)}</TableCell>
                      <TableCell
                        className={`text-right ${
                          l.change === null
                            ? "text-muted-foreground"
                            : l.change >= 0
                              ? "text-success"
                              : "text-destructive"
                        }`}
                      >
                        {pct(l.change)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {money(l.accumulated)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length > 0 && (
                    <TableRow className="bg-muted font-bold">
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right">{invoices}</TableCell>
                      <TableCell className="text-right">{money(revenue)}</TableCell>
                      <TableCell />
                      <TableCell className="text-right">{money(last?.accumulated)}</TableCell>
                    </TableRow>
                  )}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                        {monthly.isLoading ? "Loading…" : "No months in this period yet."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
