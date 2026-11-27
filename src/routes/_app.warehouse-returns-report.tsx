import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { ReportActions } from "@/components/shared/report-actions";
import { DatePicker } from "@/components/shared/date-picker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
import { useFactoryId } from "@/lib/use-factory";

export const Route = createFileRoute("/_app/warehouse-returns-report")({
  head: () => ({
    meta: [
      { title: "Warehouse Returns Report — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="finished-goods">
        <WarehouseReturnsReportPage />
      </RequireAccess>
    </>
  ),
});

type Period = "daily" | "weekly" | "monthly" | "custom";
type Category = "bottled_water" | "dispenser" | "empty_jug";
type ReturnRow = {
  return_date: string;
  category: Category;
  return_source: string;
  product_id: string | null;
  product: string;
  unit: string;
  reference: string;
  party: string;
  quantity: number;
  quantity_received: number | null;
  status: string;
  received_by: string | null;
  notes: string | null;
};

const CATEGORY_LABEL: Record<Category, string> = {
  bottled_water: "Bottled water",
  dispenser: "Dispenser water",
  empty_jug: "Empty dispenser jugs",
};

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const asUtcDate = (day: string) => new Date(`${day}T00:00:00Z`);
const asDay = (date: Date) => date.toISOString().slice(0, 10);
const shiftUtcDay = (day: string, amount: number) => {
  const date = asUtcDate(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return asDay(date);
};
const formatDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const signedRange = (from: string, to: string) =>
  from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;

function dateRange(period: Period, anchor: string, customFrom: string, customTo: string) {
  if (period === "custom") return { from: customFrom, to: customTo };
  if (period === "daily") return { from: anchor, to: anchor };
  if (period === "weekly") {
    const weekday = asUtcDate(anchor).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const from = shiftUtcDay(anchor, -mondayOffset);
    return { from, to: shiftUtcDay(from, 6) };
  }
  const [year, month] = anchor.split("-").map(Number);
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    to: asDay(new Date(Date.UTC(year, month, 0))),
  };
}

function WarehouseReturnsReportPage() {
  const { data: factoryId } = useFactoryId();
  const today = lagosToday();
  const [period, setPeriod] = useState<Period>("daily");
  const [anchor, setAnchor] = useState(today);
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [kind, setKind] = useState<"all" | Category>("all");
  const [search, setSearch] = useState("");
  const range = dateRange(period, anchor, customFrom, customTo);

  useRealtimeInvalidate(
    ["rep_returns", "rep_return_items", "sales_returns", "jug_returns"],
    [["warehouse-returns-report"]],
  );

  const report = useQuery({
    queryKey: ["warehouse-returns-report", factoryId, range.from, range.to],
    enabled: !!factoryId && !!range.from && !!range.to && range.from <= range.to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_returns_report" as never,
        { p_factory: factoryId, p_from: range.from, p_to: range.to } as never,
      );
      if (error) throw error;
      return ((data ?? []) as unknown as ReturnRow[]).map((row) => ({
        ...row,
        quantity: Number(row.quantity ?? 0),
        quantity_received:
          row.quantity_received === null ? null : Number(row.quantity_received ?? 0),
      }));
    },
  });

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (report.data ?? []).filter(
      (row) =>
        (kind === "all" || row.category === kind) &&
        (!term ||
          [row.product, row.reference, row.party, row.return_source, row.received_by]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(term))),
    );
  }, [report.data, kind, search]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (out, row) => {
          if (row.category === "bottled_water") out.bottled += row.quantity;
          else if (row.category === "dispenser") out.dispenser += row.quantity;
          else {
            out.jugsClaimed += row.quantity;
            out.jugsReceived += row.quantity_received ?? 0;
          }
          return out;
        },
        { bottled: 0, dispenser: 0, jugsClaimed: 0, jugsReceived: 0 },
      ),
    [rows],
  );

  const byProduct = useMemo(() => {
    const grouped = new Map<
      string,
      { category: Category; product: string; unit: string; quantity: number; received: number }
    >();
    for (const row of rows) {
      const key = `${row.category}|${row.product}|${row.unit}`;
      const current = grouped.get(key) ?? {
        category: row.category,
        product: row.product,
        unit: row.unit,
        quantity: 0,
        received: 0,
      };
      current.quantity += row.quantity;
      current.received += row.quantity_received ?? 0;
      grouped.set(key, current);
    }
    return [...grouped.values()].sort(
      (a, b) => a.category.localeCompare(b.category) || a.product.localeCompare(b.product),
    );
  }, [rows]);

  const exportRows = rows.map((row) => ({
    date: row.return_date,
    category: CATEGORY_LABEL[row.category],
    product: `${row.product} (${row.unit})`,
    source: row.return_source,
    party: row.party,
    reference: row.reference,
    quantity: num(row.quantity),
    quantity_received: row.quantity_received === null ? "" : num(row.quantity_received),
    status: row.status,
    received_by: row.received_by ?? "",
    notes: row.notes ?? "",
  }));
  const invalidRange = range.from > range.to;

  if (!factoryId) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Returns Report</h1>
        <p className="text-sm text-muted-foreground">
          Returned bottled water, dispenser-water products, and empty dispenser jugs. Product
          quantities count accepted returns; empty jugs show both claimed and Warehouse-counted
          quantities.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end justify-between gap-4 pt-6">
          <div className="space-y-3">
            <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
              <TabsList>
                <TabsTrigger value="daily">Daily</TabsTrigger>
                <TabsTrigger value="weekly">Weekly</TabsTrigger>
                <TabsTrigger value="monthly">Monthly</TabsTrigger>
                <TabsTrigger value="custom">Custom date</TabsTrigger>
              </TabsList>
            </Tabs>
            {period === "custom" ? (
              <div className="flex flex-wrap gap-3">
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">From</span>
                  <DatePicker
                    value={customFrom}
                    max={today}
                    onChange={(value) => {
                      setCustomFrom(value);
                      if (value > customTo) setCustomTo(value);
                    }}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">To</span>
                  <DatePicker
                    value={customTo}
                    min={customFrom}
                    max={today}
                    onChange={setCustomTo}
                  />
                </label>
              </div>
            ) : (
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">
                  {period === "daily"
                    ? "Day"
                    : period === "weekly"
                      ? "Week containing"
                      : "Month containing"}
                </span>
                <DatePicker value={anchor} max={today} onChange={setAnchor} />
              </label>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">Return category</span>
              <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All return categories</SelectItem>
                  <SelectItem value="bottled_water">Bottled water</SelectItem>
                  <SelectItem value="dispenser">Dispenser water</SelectItem>
                  <SelectItem value="empty_jug">Empty dispenser jugs</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">Find a product or return</span>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="w-60 pl-8"
                  placeholder="Product, party, reference"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            <ReportActions
              department="Warehouse Department"
              title="Returns Report"
              fileName={`warehouse-returns-${range.from}-to-${range.to}`}
              columns={[
                { key: "date", label: "Date" },
                { key: "category", label: "Category" },
                { key: "product", label: "Product" },
                { key: "source", label: "Return source" },
                { key: "party", label: "Returned by" },
                { key: "reference", label: "Reference" },
                { key: "quantity", label: "Returned / claimed" },
                { key: "quantity_received", label: "Jugs counted" },
                { key: "status", label: "Status" },
                { key: "received_by", label: "Received by" },
                { key: "notes", label: "Notes" },
              ]}
              rows={exportRows}
              subtitle={[`Warehouse — ${signedRange(range.from, range.to)}`]}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Bottled water returned" value={totals.bottled} unit="packs" />
        <SummaryCard label="Dispenser water returned" value={totals.dispenser} unit="units" />
        <SummaryCard label="Empty jugs claimed" value={totals.jugsClaimed} unit="jugs" />
        <SummaryCard
          label="Empty jugs counted by Warehouse"
          value={totals.jugsReceived}
          unit="jugs"
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Breakdown by returned item</CardTitle>
          <p className="text-sm text-muted-foreground">{signedRange(range.from, range.to)}</p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Product / jug type</TableHead>
                <TableHead className="text-right">Returned / claimed</TableHead>
                <TableHead className="text-right">Jugs counted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byProduct.map((row) => (
                <TableRow key={`${row.category}|${row.product}|${row.unit}`}>
                  <TableCell>{CATEGORY_LABEL[row.category]}</TableCell>
                  <TableCell>
                    {row.product} <span className="text-xs text-muted-foreground">{row.unit}</span>
                  </TableCell>
                  <TableCell className="text-right">{num(row.quantity)}</TableCell>
                  <TableCell className="text-right">
                    {row.category === "empty_jug" ? num(row.received) : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {byProduct.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    {invalidRange
                      ? "Choose a valid date range."
                      : report.isLoading
                        ? "Loading…"
                        : report.isError
                          ? (report.error as Error).message
                          : "No returns in this period."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Return details</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Product / jug type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Returned by</TableHead>
                <TableHead className="text-right">Returned / claimed</TableHead>
                <TableHead className="text-right">Jugs counted</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Received by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow
                  key={`${row.category}|${row.reference}|${row.product_id ?? row.product}|${index}`}
                >
                  <TableCell className="whitespace-nowrap">{formatDay(row.return_date)}</TableCell>
                  <TableCell>{CATEGORY_LABEL[row.category]}</TableCell>
                  <TableCell>
                    {row.product} <span className="text-xs text-muted-foreground">{row.unit}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.reference}</TableCell>
                  <TableCell>{row.party}</TableCell>
                  <TableCell className="text-right">{num(row.quantity)}</TableCell>
                  <TableCell className="text-right">
                    {row.category === "empty_jug" && row.quantity_received !== null
                      ? num(row.quantity_received)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        row.status === "completed" || row.status === "verified"
                          ? "secondary"
                          : "outline"
                      }
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{row.received_by ?? "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    {report.isLoading
                      ? "Loading…"
                      : report.isError
                        ? (report.error as Error).message
                        : "No returns match this period and filter."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{num(value)}</div>
        <div className="text-xs text-muted-foreground">{unit}</div>
      </CardContent>
    </Card>
  );
}
