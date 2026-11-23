import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, FileDown, FileSpreadsheet, Printer, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { letterheadReportPdf } from "@/components/qc/qc-report-pdf";
import { useFactorySettings } from "@/lib/use-factory";
import { addDays, localDay } from "@/lib/production-shift";
import { exportExcel } from "@/lib/export";
import { num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

// Store › Raw Materials: a report for any period (user, 2026-11-23) --
// Daily, Weekly (Mon–Sun), Monthly, Yearly or a Custom From–To. One line per
// material: Opening, Qty In, Issued out, Damaged, Adjustments, Closing.
// Built from raw_material_movements: each row keeps the stock before and after
// it, so its direction is after − before; Closing on the last day is today's
// stock less everything that moved after it.

type Period = "daily" | "weekly" | "monthly" | "yearly" | "custom";
type Move = {
  material_id: string;
  movement_type: string;
  quantity: number;
  quantity_before: number | null;
  quantity_after: number | null;
  created_at: string;
};
type Material = {
  id: string;
  name: string;
  unit: string | null;
  current_stock: number;
  active: boolean;
};
type Line = {
  id: string;
  name: string;
  unit: string;
  opening: number;
  qty_in: number;
  issued: number;
  damaged: number;
  adjusted: number;
  closing: number;
};

// Rows without a before/after figure (older entries) take their direction
// from the type.
const IN_TYPES = new Set([
  "received",
  "opening_balance",
  "return_from_production",
  "return_from_rep",
  "returned",
  "produced",
]);
const DAMAGE_TYPES = new Set(["damaged", "expiry"]);
const ADJUST_TYPES = new Set(["adjusted", "correction"]);

const signed = (m: Move) => {
  if (m.quantity_before != null && m.quantity_after != null)
    return Number(m.quantity_after) - Number(m.quantity_before);
  const q = Math.abs(Number(m.quantity));
  return IN_TYPES.has(m.movement_type) ? q : -q;
};

// The Lagos day a movement happened on.
const lagosDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function rangeFor(
  period: Period,
  day: string,
  month: string,
  year: string,
  from: string,
  to: string,
): [string, string, string] {
  const today = localDay();
  if (period === "daily") return [day, day, `Date: ${day}`];
  if (period === "weekly") {
    const d = new Date(`${day}T12:00:00`);
    const monday = addDays(day, -((d.getDay() + 6) % 7));
    const sunday = addDays(monday, 6);
    return [monday, sunday, `Week: ${monday} to ${sunday}`];
  }
  if (period === "monthly") {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(y, m, 0).getDate();
    return [
      `${month}-01`,
      `${month}-${String(last).padStart(2, "0")}`,
      `Month: ${MONTHS[m - 1]} ${y}`,
    ];
  }
  if (period === "yearly") return [`${year}-01-01`, `${year}-12-31`, `Year: ${year}`];
  const [a, b] = from > to ? [to, from] : [from, to];
  return [a, b, a === b ? `Date: ${a}` : `From ${a} to ${b}`];
}

export function StorePeriodReport({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const today = localDay();
  const [period, setPeriod] = useState<Period>("monthly");
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [onlyMoved, setOnlyMoved] = useState(true);

  const [start, end, label] = rangeFor(period, day, month, year, from, to);
  const years = useMemo(() => {
    const y = Number(today.slice(0, 4));
    return Array.from({ length: 6 }, (_, i) => String(y - i));
  }, [today]);

  const materials = useQuery({
    queryKey: ["store-report-materials", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,current_stock,active")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Material[];
    },
  });

  // Everything from the first day on: the period's own rows, and the later
  // ones that take today's stock back to the closing figure.
  const moves = useQuery({
    queryKey: ["store-report-moves", factoryId, start],
    queryFn: async () => {
      const out: Move[] = [];
      const since = `${start}T00:00:00+01:00`;
      for (let page = 0; ; page++) {
        const { data, error } = await supabase
          .from("raw_material_movements")
          .select("material_id,movement_type,quantity,quantity_before,quantity_after,created_at")
          .eq("factory_id", factoryId)
          .gte("created_at", since)
          .order("created_at", { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (error) throw error;
        out.push(...((data ?? []) as unknown as Move[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  });

  const lines = useMemo<Line[]>(() => {
    const by = new Map<string, Line>();
    for (const m of materials.data ?? []) {
      by.set(m.id, {
        id: m.id,
        name: m.name,
        unit: m.unit ?? "",
        opening: 0,
        qty_in: 0,
        issued: 0,
        damaged: 0,
        adjusted: 0,
        // Today's stock; the moves after the period are taken off below.
        closing: Number(m.current_stock),
      });
    }
    for (const mv of moves.data ?? []) {
      const l = by.get(mv.material_id);
      if (!l) continue;
      const d = lagosDay(mv.created_at);
      const delta = signed(mv);
      if (d > end) {
        l.closing -= delta;
        continue;
      }
      if (d < start) continue;
      if (ADJUST_TYPES.has(mv.movement_type)) l.adjusted += delta;
      else if (DAMAGE_TYPES.has(mv.movement_type)) l.damaged += -delta;
      else if (delta >= 0) l.qty_in += delta;
      else l.issued += -delta;
    }
    for (const l of by.values())
      l.opening = l.closing - l.qty_in + l.issued + l.damaged - l.adjusted;
    return [...by.values()];
  }, [materials.data, moves.data, start, end]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const active = new Set((materials.data ?? []).filter((m) => m.active).map((m) => m.id));
    return lines.filter(
      (l) =>
        (!term || l.name.toLowerCase().includes(term)) &&
        (!onlyMoved
          ? active.has(l.id) || l.qty_in || l.issued || l.damaged || l.adjusted
          : l.qty_in || l.issued || l.damaged || l.adjusted),
    );
  }, [lines, q, onlyMoved, materials.data]);

  const total = (k: keyof Line) => shown.reduce((t, l) => t + Number(l[k]), 0);
  const columns = [
    { key: "sn", label: "S/N" },
    { key: "material", label: "Material" },
    { key: "opening", label: "Opening" },
    { key: "qty_in", label: "Qty In" },
    { key: "issued", label: "Issued Out" },
    { key: "damaged", label: "Damaged" },
    { key: "adjusted", label: "Adjustments" },
    { key: "closing", label: "Closing" },
  ];
  const asRows = () => [
    ...shown.map((l, i) => ({
      sn: i + 1,
      material: `${l.name}${l.unit ? ` (${l.unit})` : ""}`,
      opening: num(l.opening),
      qty_in: num(l.qty_in),
      issued: num(l.issued),
      damaged: num(l.damaged),
      adjusted: num(l.adjusted),
      closing: num(l.closing),
    })),
    {
      sn: "",
      material: "Total",
      opening: num(total("opening")),
      qty_in: num(total("qty_in")),
      issued: num(total("issued")),
      damaged: num(total("damaged")),
      adjusted: num(total("adjusted")),
      closing: num(total("closing")),
    },
  ];
  const fileName = `store-report-${start === end ? start : `${start}-to-${end}`}`;
  const titleOf = {
    daily: "Daily Store Report",
    weekly: "Weekly Store Report",
    monthly: "Monthly Store Report",
    yearly: "Yearly Store Report",
    custom: "Store Report",
  }[period];
  const pdf = (action: "download" | "print") =>
    letterheadReportPdf(
      {
        department: "Store Department",
        title: titleOf,
        settings: settings.data,
        filename: fileName,
        subtitle: [label],
        columns,
        rows: asRows(),
      },
      action,
    );

  const loading = materials.isLoading || moves.isLoading;
  const error = (materials.error ?? moves.error) as Error | null;

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5" /> Store Report
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Pick a day, week, month, year or your own From–To dates, then print. One line per
          material: Opening, what came in, what was issued out, damaged, adjustments and Closing.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">Period</Label>
            <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
              <SelectTrigger className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
                <SelectItem value="custom">Custom (From – To)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(period === "daily" || period === "weekly") && (
            <div>
              <Label className="text-xs">
                {period === "weekly" ? "Any day in the week" : "Day"}
              </Label>
              <Input
                type="date"
                value={day}
                max={today}
                onChange={(e) => e.target.value && setDay(e.target.value)}
                className="h-9 w-40"
              />
            </div>
          )}
          {period === "monthly" && (
            <div>
              <Label className="text-xs">Month</Label>
              <Input
                type="month"
                value={month}
                max={today.slice(0, 7)}
                onChange={(e) => e.target.value && setMonth(e.target.value)}
                className="h-9 w-44"
              />
            </div>
          )}
          {period === "yearly" && (
            <div>
              <Label className="text-xs">Year</Label>
              <Select value={year} onValueChange={setYear}>
                <SelectTrigger className="h-9 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={y}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {period === "custom" && (
            <div>
              <Label className="text-xs">From – To</Label>
              <div className="flex items-center gap-1">
                <Input
                  type="date"
                  value={from}
                  max={today}
                  onChange={(e) => e.target.value && setFrom(e.target.value)}
                  className="h-9 w-40"
                  aria-label="From date"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  value={to}
                  max={today}
                  onChange={(e) => e.target.value && setTo(e.target.value)}
                  className="h-9 w-40"
                  aria-label="To date"
                />
              </div>
            </div>
          )}
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyMoved}
              onChange={(e) => setOnlyMoved(e.target.checked)}
            />
            Only materials that moved
          </label>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search material…"
              className="h-9 pl-8"
            />
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-2"
              disabled={!shown.length}
              onClick={() => void pdf("print")}
            >
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              disabled={!shown.length}
              onClick={() => void pdf("download")}
            >
              <FileDown className="h-4 w-4" /> PDF
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              disabled={!shown.length}
              onClick={() => exportExcel(fileName, columns, asRows())}
            >
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
          </div>
        </div>
        <p className="text-sm font-medium">{label}</p>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>S/N</TableHead>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Qty In</TableHead>
                <TableHead className="text-right">Issued Out</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead className="text-right">Adjustments</TableHead>
                <TableHead className="text-right">Closing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((l, i) => (
                <TableRow key={l.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">
                    {l.name}
                    {l.unit && (
                      <span className="ml-1 text-xs text-muted-foreground">({l.unit})</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{num(l.opening)}</TableCell>
                  <TableCell className="text-right">{num(l.qty_in)}</TableCell>
                  <TableCell className="text-right">{num(l.issued)}</TableCell>
                  <TableCell className="text-right">{num(l.damaged)}</TableCell>
                  <TableCell className="text-right">{num(l.adjusted)}</TableCell>
                  <TableCell className="text-right font-semibold">{num(l.closing)}</TableCell>
                </TableRow>
              ))}
              {shown.length > 0 && (
                <TableRow className="bg-muted/50 font-semibold">
                  <TableCell />
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right">{num(total("opening"))}</TableCell>
                  <TableCell className="text-right">{num(total("qty_in"))}</TableCell>
                  <TableCell className="text-right">{num(total("issued"))}</TableCell>
                  <TableCell className="text-right">{num(total("damaged"))}</TableCell>
                  <TableCell className="text-right">{num(total("adjusted"))}</TableCell>
                  <TableCell className="text-right">{num(total("closing"))}</TableCell>
                </TableRow>
              )}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    {loading
                      ? "Loading…"
                      : error
                        ? error.message
                        : "No store movement in this period."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
