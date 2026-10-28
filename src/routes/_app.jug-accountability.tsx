import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Container,
  Download,
  FileSpreadsheet,
  Factory,
  PackageCheck,
  Plus,
  Printer,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  Undo2,
} from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { Badge } from "@/components/ui/badge";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReasonDialog, fmtDateTime } from "@/components/preform/shared";
import { rpc, useUserNames } from "@/components/preform/api";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { usePermissions } from "@/lib/permissions";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { exportCsv, exportExcel, type ReportColumn } from "@/lib/export";
import { DatePicker } from "@/components/shared/date-picker";
import { qcLetterheadPdf, sheetCompany } from "@/components/qc/qc-report-pdf";
import { formatDay, rowIsConsistent, totalRows } from "@/lib/jug-accountability";
import {
  SOURCE_LABEL,
  useJugAction,
  useJugLive,
  useJugMovements,
  useJugOverview,
  useJugReport,
  useJugReturns,
  useJugTypes,
  useMarketers,
  useProductLinks,
  type JugReturn,
  type ReportRow,
} from "@/components/jugs/api";
import {
  AdjustDialog,
  JugSetupPanel,
  ReceiveNewJugsDialog,
  ReceiveUnsoldDialog,
  RecordReturnDialog,
  RowDetailDialog,
} from "@/components/jugs/dialogs";
import { WarehouseJugsToQc } from "@/components/qc/jug-handover";

const TABS = ["report", "jugs", "returns", "setup"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/jug-accountability")({
  head: () => ({
    meta: [
      { title: "Dispenser Production & Jug Accountability — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.includes(s.tab as Tab) ? (s.tab as Tab) : undefined,
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="distribution" anyOf={["finished-goods", "marketer-accounts"]}>
        <JugAccountabilityPage />
      </RequireAccess>
    </>
  ),
});

// As on the factory's Empty Jugs Report sheet, with the date after S/N.
// Empties sold and write-offs still count in Expected / Outstanding (see the
// row detail); they are not columns of the report.
const COLUMNS: (ReportColumn & { align?: "right" })[] = [
  { key: "sn", label: "S/N" },
  { key: "date", label: "Date" },
  { key: "code", label: "ID" },
  { key: "name", label: "Marketer" },
  { key: "jug", label: "Jug" },
  { key: "opening", label: "Opening", align: "right" },
  { key: "loaded", label: "Loaded", align: "right" },
  { key: "total", label: "Total", align: "right" },
  { key: "jug_water_sold", label: "Dispenser/Jug Water Sold", align: "right" },
  { key: "returned", label: "Returned", align: "right" },
  { key: "expected_empties", label: "Expected", align: "right" },
  { key: "received", label: "Received", align: "right" },
  { key: "outstanding", label: "Outstanding", align: "right" },
];

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "primary",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  tone?: "primary" | "warning" | "destructive";
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card className="rounded-2xl">
      <CardContent className="flex items-start justify-between gap-2 p-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-1.5 text-xl font-semibold">{value}</div>
          {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
        </div>
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${toneClasses}`}>
          <Icon className="h-4 w-4" />
        </div>
      </CardContent>
    </Card>
  );
}

// Warehouse → Dispenser & jugs: each marketer's / outlet's daily empty-jug
// accountability, the jug pool, and the claim -> Warehouse count of empties
// brought back. Every figure is computed by the server from the container
// ledger (supabase/migrations/20261020200000_jug_accountability.sql).
function JugAccountabilityPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const me = useCurrentUserName();
  const { can } = usePermissions();
  useJugLive();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const current = tab ?? "report";
  const goTo = (t: Tab) =>
    navigate({ search: { tab: t === "report" ? undefined : t }, replace: true, state: (p) => p });

  // From / To picked on a calendar (one day = the same date twice). The
  // pickers only give real dates; To never falls before From.
  const today = localDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const pickFrom = (d: string) => {
    setFrom(d);
    if (d > to) setTo(d);
  };

  const [typeId, setTypeId] = useState("all");
  const [q, setQ] = useState("");
  const [onlyOutstanding, setOnlyOutstanding] = useState("all");
  const types = useJugTypes(factoryId);
  const marketers = useMarketers(factoryId);
  const links = useProductLinks(factoryId);
  const report = useJugReport(factoryId, from, to, typeId === "all" ? null : typeId);
  const overview = useJugOverview(factoryId, from, to);
  const returns = useJugReturns(factoryId, from, to);
  const productNames = useMemo(
    () => Object.fromEntries((links.data?.products ?? []).map((p) => [p.id, p.name])),
    [links.data],
  );

  const canRecordReturn = can("distribution", "create") || can("sales", "create");
  const canVerify = can("distribution", "confirm");
  const canAdjust = can("distribution", "create");
  const canWriteOff = can("distribution", "approve");
  const canSetup = can("distribution", "approve");
  // Same permission create_rep_return checks on the server.
  const canReceiveUnsold = can("distribution", "submit");
  // Same permissions receive_new_jugs checks on the server.
  const canReceiveNew = can("distribution", "confirm") || can("distribution", "approve");

  const [dialog, setDialog] = useState<
    | { kind: "return"; repId?: string; typeId?: string }
    | { kind: "adjust" }
    | { kind: "unsold" }
    | { kind: "new" }
    | { kind: "row"; row: ReportRow }
    | null
  >(null);

  const rows = (report.data ?? []).filter((r) => {
    const term = q.trim().toLowerCase();
    return (
      (!term ||
        r.rep_name.toLowerCase().includes(term) ||
        (r.rep_code ?? "").toLowerCase().includes(term)) &&
      (onlyOutstanding === "all" ||
        (onlyOutstanding === "outstanding" && r.outstanding > 0) ||
        (onlyOutstanding === "over" && r.outstanding < 0) ||
        (onlyOutstanding === "pending" && r.pending_claims > 0))
    );
  });
  const totals = totalRows(rows);
  const inconsistent = rows.filter((r) => !rowIsConsistent(r)).length;
  const lastDay = rows.length ? rows[rows.length - 1].report_date : to;
  const outstandingNow = rows
    .filter((r) => r.report_date === lastDay)
    .reduce((s, r) => s + Math.max(r.outstanding, 0), 0);
  const ov = (overview.data ?? []).filter(
    (o) => typeId === "all" || o.container_type_id === typeId,
  );
  const sumOv = (k: keyof (typeof ov)[number]) => ov.reduce((s, o) => s + Number(o[k] ?? 0), 0);
  const period = from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;

  const exportRows = rows.map((r, i) => ({
    sn: i + 1,
    date: r.report_date,
    code: r.rep_code ?? "",
    name: r.rep_name,
    jug: r.container_name,
    opening: r.opening,
    loaded: r.loaded,
    total: r.total,
    jug_water_sold: r.jug_water_sold,
    returned: r.returned,
    expected_empties: r.expected_empties,
    received: r.received,
    outstanding: r.outstanding,
  }));
  const fileName = `jug-accountability-${from}${from === to ? "" : `-to-${to}`}`;
  // The factory's printed form: letterhead, "EMPTY JUGS REPORT FROM … TO …",
  // the table with a totals row, then a summary. The Jug column only when
  // more than one jug type is on the report.
  const printReport = () => {
    const multiJug = new Set(rows.map((r) => r.container_type_id)).size > 1;
    const cols = COLUMNS.filter((c) => multiJug || c.key !== "jug");
    const at = (k: string) => cols.findIndex((c) => c.key === k);
    const foot: (string | number)[] = cols.map(() => "");
    foot[at("name")] = from === to ? "Total" : "Total (period)";
    for (const k of [
      "opening",
      "loaded",
      "total",
      "jug_water_sold",
      "returned",
      "expected_empties",
      "received",
      "outstanding",
    ] as const)
      foot[at(k)] = num(totals[k]);
    const owing = rows.filter((r) => r.report_date === lastDay && r.outstanding > 0).length;
    void qcLetterheadPdf({
      company: sheetCompany(settings.data),
      filename: fileName,
      reports: [
        {
          title: `Empty Jugs Report from ${from} to ${to}`,
          columns: cols.map((c) => ({ label: c.label, align: c.align })),
          rows: exportRows.map((r) =>
            cols.map((c) => {
              const v = r[c.key as keyof typeof r];
              return typeof v === "number" && c.key !== "sn" ? num(v) : v;
            }),
          ),
          foot,
          summary: [
            ["Marketers / outlets", new Set(rows.map((r) => r.sales_rep_id)).size],
            ["Jugs loaded", num(totals.loaded)],
            ["Dispenser/Jug Water sold", num(totals.jug_water_sold)],
            ["Empties expected", num(totals.expected_empties)],
            ["Empties received", num(totals.received)],
            [`Outstanding at end of ${formatDay(lastDay)}`, num(outstandingNow)],
            ["Marketers still owing", owing],
            ["Printed by", me.data ?? "—"],
            ["Printed on", new Date().toLocaleString("en-GB")],
          ],
        },
      ],
    });
  };

  if (!factoryId) return null;
  const noJugs = (types.data ?? []).length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Dispenser Production &amp; Jug Accountability
        </h1>
        <p className="text-sm text-muted-foreground">
          Opening + Loaded = Total; Total − Dispenser/Jug Water sold = Expected; Expected − Received
          (Warehouse-verified) = Outstanding, carried to the next day&apos;s Opening. Empty jugs
          sold and approved write-offs also reduce Expected / Outstanding — click a row to see them.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-2 p-3">
          <div className="space-y-1">
            <Label htmlFor="jug-from" className="text-xs">
              From
            </Label>
            <DatePicker id="jug-from" value={from} max={today} onChange={pickFrom} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="jug-to" className="text-xs">
              To
            </Label>
            <DatePicker id="jug-to" value={to} min={from} max={today} onChange={setTo} />
          </div>
          <Button className="gap-2" onClick={printReport} disabled={!rows.length}>
            <Printer className="h-4 w-4" /> Print
          </Button>
          <Button variant="secondary" className="gap-2" onClick={() => goTo("jugs")}>
            <Container className="h-4 w-4" /> Jug(s)
          </Button>
          <div className="space-y-1">
            <Label className="text-xs">Jug</Label>
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All jug types</SelectItem>
                {(types.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Show</Label>
            <Select value={onlyOutstanding} onValueChange={setOnlyOutstanding}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                <SelectItem value="outstanding">Outstanding &gt; 0</SelectItem>
                <SelectItem value="pending">Returns awaiting count</SelectItem>
                <SelectItem value="over">Over-returned (&lt; 0)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative min-w-48 flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Marketer, outlet or ID…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="outline"
              title="Excel"
              onClick={() => exportExcel(fileName, COLUMNS, exportRows)}
            >
              <FileSpreadsheet className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              title="CSV"
              onClick={() => exportCsv(fileName, COLUMNS, exportRows)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {noJugs && (
        <Card className="rounded-2xl border-warning/50 bg-warning/5">
          <CardContent className="p-4 text-sm">
            No jug type is set up yet.{" "}
            {canSetup
              ? "Add one and link the dispenser products in the Setup tab."
              : "Ask a manager to set up jug types and dispenser products."}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          icon={Factory}
          label="Produced & approved"
          value={num(sumOv("produced_approved"))}
          hint="Filled jugs accepted into the Warehouse"
        />
        <Stat
          icon={Truck}
          label="Issued"
          value={num(sumOv("issued"))}
          hint="Loaded to marketers / outlets"
        />
        <Stat
          icon={ShoppingCart}
          label="Sold"
          value={num(sumOv("sold_with_water") + sumOv("empties_sold"))}
          hint={`${num(sumOv("sold_with_water"))} Dispenser/Jug Water · ${num(sumOv("empties_sold"))} empties · ${num(sumOv("refills_sold"))} refills (swaps)`}
        />
        <Stat
          icon={CheckCircle2}
          label="Returned & verified"
          value={num(sumOv("received"))}
          hint={`${num(sumOv("pending_returns"))} awaiting the Warehouse count`}
        />
        <Stat
          icon={AlertTriangle}
          label="Outstanding"
          value={num(outstandingNow)}
          hint={`With marketers at end of ${formatDay(lastDay)}`}
          tone={outstandingNow ? "warning" : "primary"}
        />
      </div>

      <Tabs value={current} onValueChange={(v) => goTo(v as Tab)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="report">Daily accountability</TabsTrigger>
          <TabsTrigger value="jugs">Jugs</TabsTrigger>
          <TabsTrigger value="returns">
            Returns
            {(returns.data ?? []).filter((r) => r.status === "pending").length > 0 && (
              <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">
                {(returns.data ?? []).filter((r) => r.status === "pending").length}
              </Badge>
            )}
          </TabsTrigger>
          {canSetup && <TabsTrigger value="setup">Setup</TabsTrigger>}
        </TabsList>

        <TabsContent value="report">
          <Card className="rounded-2xl">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <div>
                <CardTitle>Accountability — {period}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Click a row for the transactions behind it. Returned is what the marketer says
                  they brought; only Received (counted by the Warehouse) reduces Outstanding.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canRecordReturn && (
                  <Button
                    className="gap-2"
                    onClick={() => setDialog({ kind: "return" })}
                    disabled={noJugs}
                  >
                    <Undo2 className="h-4 w-4" /> Record return
                  </Button>
                )}
                {canAdjust && (
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={() => setDialog({ kind: "adjust" })}
                    disabled={noJugs}
                  >
                    <SlidersHorizontal className="h-4 w-4" /> Adjustment
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {inconsistent > 0 && (
                <p className="mb-2 text-xs text-destructive">
                  {inconsistent} row(s) do not add up — report this; nothing has been changed.
                </p>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>S/N</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>Marketer</TableHead>
                    <TableHead className="text-right">Opening</TableHead>
                    <TableHead className="text-right">Loaded</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Dispenser/Jug Water Sold</TableHead>
                    <TableHead className="text-right">Returned</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                        {report.isLoading
                          ? "Loading…"
                          : report.error
                            ? (report.error as Error).message
                            : "No jug activity or balances for this period."}
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r, i) => (
                    <TableRow
                      key={`${r.report_date}-${r.sales_rep_id}-${r.container_type_id}`}
                      className="cursor-pointer"
                      onClick={() => setDialog({ kind: "row", row: r })}
                    >
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {formatDay(r.report_date)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.rep_code ?? "—"}</TableCell>
                      <TableCell>
                        {r.rep_name}
                        {(types.data ?? []).length > 1 && (
                          <div className="text-[11px] text-muted-foreground">
                            {r.container_name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{num(r.opening)}</TableCell>
                      <TableCell className="text-right">{num(r.loaded)}</TableCell>
                      <TableCell className="text-right font-medium">{num(r.total)}</TableCell>
                      <TableCell className="text-right">{num(r.jug_water_sold)}</TableCell>
                      <TableCell className="text-right">
                        {num(r.returned)}
                        {r.pending_claims > 0 && (
                          <div className="text-[11px] text-warning">
                            {num(r.pending_claims)} to count
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{num(r.expected_empties)}</TableCell>
                      <TableCell className="text-right">{num(r.received)}</TableCell>
                      <TableCell
                        className={`text-right font-semibold ${r.outstanding > 0 ? "text-warning" : r.outstanding < 0 ? "text-destructive" : "text-primary"}`}
                      >
                        {num(r.outstanding)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                {rows.length > 0 && (
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={4}>Total{from !== to ? " (period)" : ""}</TableCell>
                      <TableCell className="text-right">{num(totals.opening)}</TableCell>
                      <TableCell className="text-right">{num(totals.loaded)}</TableCell>
                      <TableCell className="text-right">{num(totals.total)}</TableCell>
                      <TableCell className="text-right">{num(totals.jug_water_sold)}</TableCell>
                      <TableCell className="text-right">{num(totals.returned)}</TableCell>
                      <TableCell className="text-right">{num(totals.expected_empties)}</TableCell>
                      <TableCell className="text-right">{num(totals.received)}</TableCell>
                      <TableCell className="text-right">{num(totals.outstanding)}</TableCell>
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="jugs">
          <JugsPanel
            factoryId={factoryId}
            from={from}
            to={to}
            typeId={typeId === "all" ? null : typeId}
            overview={ov}
            marketers={marketers.data ?? []}
            productNames={productNames}
            typeNames={Object.fromEntries((types.data ?? []).map((t) => [t.id, t.name]))}
            onReceiveUnsold={
              canReceiveUnsold && !noJugs ? () => setDialog({ kind: "unsold" }) : undefined
            }
            onReceiveNew={canReceiveNew && !noJugs ? () => setDialog({ kind: "new" }) : undefined}
          />
        </TabsContent>

        <TabsContent value="returns">
          <ReturnsPanel
            returns={returns.data ?? []}
            loading={returns.isLoading}
            canVerify={canVerify}
            canRecord={canRecordReturn}
            marketerNames={Object.fromEntries((marketers.data ?? []).map((m) => [m.id, m.name]))}
            typeNames={Object.fromEntries((types.data ?? []).map((t) => [t.id, t.name]))}
            onRecord={() => setDialog({ kind: "return" })}
          />
        </TabsContent>

        {canSetup && (
          <TabsContent value="setup">
            <JugSetupPanel factoryId={factoryId} types={types.data ?? []} />
          </TabsContent>
        )}
      </Tabs>

      {dialog?.kind === "return" && (
        <RecordReturnDialog
          marketers={(marketers.data ?? []).filter((m) => m.active)}
          types={(types.data ?? []).filter((t) => t.active)}
          initialRepId={dialog.repId}
          initialTypeId={dialog.typeId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "adjust" && (
        <AdjustDialog
          factoryId={factoryId}
          marketers={marketers.data ?? []}
          types={(types.data ?? []).filter((t) => t.active)}
          canWriteOff={canWriteOff}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "unsold" && (
        <ReceiveUnsoldDialog
          factoryId={factoryId}
          marketers={(marketers.data ?? []).filter((m) => m.active)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "new" && (
        <ReceiveNewJugsDialog
          factoryId={factoryId}
          types={(types.data ?? []).filter((t) => t.active)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "row" && (
        <RowDetailDialog
          factoryId={factoryId}
          row={dialog.row}
          productNames={productNames}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function JugsPanel({
  factoryId,
  from,
  to,
  typeId,
  overview,
  marketers,
  productNames,
  typeNames,
  onReceiveUnsold,
  onReceiveNew,
}: {
  factoryId: string;
  from: string;
  to: string;
  typeId: string | null;
  overview: NonNullable<ReturnType<typeof useJugOverview>["data"]>;
  marketers: { id: string; name: string; code?: string | null }[];
  productNames: Record<string, string>;
  typeNames: Record<string, string>;
  onReceiveUnsold?: () => void;
  onReceiveNew?: () => void;
}) {
  const movements = useJugMovements(factoryId, from, to);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("all");
  const repName = useMemo(
    () => Object.fromEntries(marketers.map((m) => [m.id, m.name])),
    [marketers],
  );
  const names = useUserNames((movements.data ?? []).map((m) => m.created_by));
  const holder = (t: string, id: string | null) =>
    t === "sales_rep"
      ? (repName[id ?? ""] ?? "Marketer")
      : t === "warehouse"
        ? "Warehouse"
        : t === "customer"
          ? "Customer"
          : t === "walk_in"
            ? "Walk-in"
            : "Outside";
  const lines = (movements.data ?? []).filter((m) => {
    const term = q.trim().toLowerCase();
    return (
      (!typeId || m.container_type_id === typeId) &&
      (source === "all" || m.source === source) &&
      (!term ||
        (m.reference ?? "").toLowerCase().includes(term) ||
        holder(m.from_type, m.from_id).toLowerCase().includes(term) ||
        holder(m.to_type, m.to_id).toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-4">
      {(onReceiveNew || onReceiveUnsold) && (
        <div className="flex flex-wrap justify-end gap-2">
          {onReceiveNew && (
            <Button className="gap-2" onClick={onReceiveNew}>
              <PackageCheck className="h-4 w-4" /> Receive new jugs
            </Button>
          )}
          {onReceiveUnsold && (
            <Button variant="secondary" className="gap-2" onClick={onReceiveUnsold}>
              <Undo2 className="h-4 w-4" /> Receive unsold dispensers
            </Button>
          )}
        </div>
      )}
      <WarehouseJugsToQc factoryId={factoryId} />
      {overview.length === 0 && (
        <Card className="rounded-2xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No jug types set up.
          </CardContent>
        </Card>
      )}
      {overview.map((o) => (
        <Card key={o.container_type_id} className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{o.container_name}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ["In circulation", o.in_circulation, "Owned and not written off"],
                ["Empty in Warehouse", o.empty_in_warehouse, "Ready for filling"],
                ["Filled in Warehouse", o.filled_in_warehouse, "Finished goods available"],
                ["With marketers", o.with_marketers, `${num(o.full_with_marketers)} still full`],
                ["With customers", o.with_customers, "Dispenser/Jug Water / empties sold"],
                ["Written off", o.written_off_total, "Lost or damaged"],
              ] as [string, number, string][]
            ).map(([label, v, hint]) => (
              <div key={label} className="rounded-xl border p-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className={`text-lg font-semibold ${v < 0 ? "text-destructive" : ""}`}>
                  {num(v)}
                </div>
                <div className="text-[11px] text-muted-foreground">{hint}</div>
              </div>
            ))}
            {o.empty_in_warehouse < 0 && (
              <p className="text-xs text-destructive sm:col-span-3 lg:col-span-6">
                Filled stock is higher than the jugs the Warehouse holds on the ledger — jugs bought
                or held before tracking began were never recorded. Record them (Receive new jugs)
                rather than adjusting stock.
              </p>
            )}
          </CardContent>
        </Card>
      ))}

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle>
            Jug movements —{" "}
            {from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`}
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All movement types</SelectItem>
                {Object.entries(SOURCE_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="w-56 pl-8"
                placeholder="Reference or marketer…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Jug</TableHead>
                <TableHead>From → To</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Jugs</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    {movements.isLoading ? "Loading…" : "No movements."}
                  </TableCell>
                </TableRow>
              )}
              {lines.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDateTime(m.created_at)}
                  </TableCell>
                  <TableCell className="text-xs">{SOURCE_LABEL[m.source] ?? m.source}</TableCell>
                  <TableCell className="text-xs">{typeNames[m.container_type_id] ?? "—"}</TableCell>
                  <TableCell className="text-xs">
                    {holder(m.from_type, m.from_id)} → {holder(m.to_type, m.to_id)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {m.product_id ? (productNames[m.product_id] ?? "—") : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{m.reference ?? "—"}</TableCell>
                  <TableCell className="text-right font-medium">{num(m.quantity)}</TableCell>
                  <TableCell className="text-xs">
                    {names.data?.[m.created_by ?? ""] ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ReturnsPanel({
  returns,
  loading,
  canVerify,
  canRecord,
  marketerNames,
  typeNames,
  onRecord,
}: {
  returns: JugReturn[];
  loading: boolean;
  canVerify: boolean;
  canRecord: boolean;
  marketerNames: Record<string, string>;
  typeNames: Record<string, string>;
  onRecord: () => void;
}) {
  const names = useUserNames(returns.flatMap((r) => [r.recorded_by, r.verified_by]));
  const [act, setAct] = useState<{ kind: "verify" | "cancel"; r: JugReturn } | null>(null);
  const verify = useJugAction(
    (a: { id: string; qty: number; note: string }) =>
      rpc<{ reference: string; received: number; short: number }>("verify_jug_return", {
        p_id: a.id,
        p_received: a.qty,
        p_note: a.note || null,
      }),
    (r) => {
      const x = r as { reference: string; received: number; short: number };
      return Number(x.short) > 0
        ? `${x.reference}: ${num(Number(x.received))} received — ${num(Number(x.short))} still outstanding`
        : `${x.reference}: ${num(Number(x.received))} received into the Warehouse`;
    },
  );
  const cancel = useJugAction(
    (a: { id: string; reason: string }) =>
      rpc("cancel_jug_return", { p_id: a.id, p_reason: a.reason }),
    "Return cancelled",
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Empty-jug returns</CardTitle>
          <p className="text-xs text-muted-foreground">
            Recorded returns wait here until a Warehouse officer — not the person who recorded them
            — counts the jugs. Only the count moves jugs into the Warehouse.
          </p>
        </div>
        {canRecord && (
          <Button className="gap-2" onClick={onRecord}>
            <Plus className="h-4 w-4" /> Record return
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Marketer / outlet</TableHead>
              <TableHead>Jug</TableHead>
              <TableHead className="text-right">Returned</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead>Recorded</TableHead>
              <TableHead>Counted</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {returns.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {loading ? "Loading…" : "No returns in this period."}
                </TableCell>
              </TableRow>
            )}
            {returns.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                <TableCell>{marketerNames[r.sales_rep_id] ?? "—"}</TableCell>
                <TableCell className="text-xs">{typeNames[r.container_type_id] ?? "—"}</TableCell>
                <TableCell className="text-right">{num(r.quantity_claimed)}</TableCell>
                <TableCell className="text-right">
                  {r.quantity_received == null ? "—" : num(r.quantity_received)}
                  {r.quantity_received != null && r.quantity_received < r.quantity_claimed && (
                    <div className="text-[11px] text-destructive">
                      {num(r.quantity_claimed - r.quantity_received)} short
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {fmtDateTime(r.recorded_at)}
                  <div className="text-muted-foreground">{names.data?.[r.recorded_by] ?? ""}</div>
                </TableCell>
                <TableCell className="text-xs">
                  {r.verified_at ? fmtDateTime(r.verified_at) : "—"}
                  <div className="text-muted-foreground">
                    {names.data?.[r.verified_by ?? ""] ?? ""}
                  </div>
                  {r.verify_note && <div className="text-muted-foreground">{r.verify_note}</div>}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      r.status === "verified"
                        ? "default"
                        : r.status === "pending"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {r.status === "pending"
                      ? "Awaiting count"
                      : r.status === "verified"
                        ? "Received"
                        : "Cancelled"}
                  </Badge>
                  {r.cancel_reason && (
                    <div className="text-[11px] text-muted-foreground">{r.cancel_reason}</div>
                  )}
                </TableCell>
                <TableCell>
                  {r.status === "pending" && (
                    <div className="flex justify-end gap-1">
                      {canVerify && (
                        <Button size="sm" onClick={() => setAct({ kind: "verify", r })}>
                          Confirm count
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAct({ kind: "cancel", r })}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <ReasonDialog
        open={act?.kind === "verify"}
        onOpenChange={(o) => !o && setAct(null)}
        title={`Count ${act?.r.reference ?? ""}`}
        description={`${act ? (marketerNames[act.r.sales_rep_id] ?? "") : ""} says ${num(act?.r.quantity_claimed ?? 0)} empty jugs. Enter what you physically counted.`}
        label="Note (required if the count differs)"
        required={false}
        quantity={{ label: "Empty jugs counted", initial: act?.r.quantity_claimed ?? null }}
        confirmLabel="Confirm count"
        pending={verify.isPending}
        onConfirm={(note, qty) =>
          act &&
          verify.mutate({ id: act.r.id, qty: qty ?? 0, note }, { onSuccess: () => setAct(null) })
        }
      />
      <ReasonDialog
        open={act?.kind === "cancel"}
        onOpenChange={(o) => !o && setAct(null)}
        title={`Cancel ${act?.r.reference ?? ""}`}
        description="Only for a return recorded in error. Nothing has moved yet."
        destructive
        confirmLabel="Cancel return"
        pending={cancel.isPending}
        onConfirm={(reason) =>
          act && cancel.mutate({ id: act.r.id, reason }, { onSuccess: () => setAct(null) })
        }
      />
    </Card>
  );
}
