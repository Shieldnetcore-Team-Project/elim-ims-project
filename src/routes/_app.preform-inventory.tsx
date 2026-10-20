import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  Download,
  History,
  Layers,
  PackageMinus,
  PackagePlus,
  Plus,
  Search,
  Send,
  Truck,
} from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { addDays, localDay } from "@/lib/production-shift";
import { money, num } from "@/lib/format";
import { splitBags } from "@/lib/preform-units";
import { exportCsv } from "@/lib/export";
import { fmtDateTime } from "@/components/preform/shared";
import { IssueDialog } from "@/components/preform/issues";
import { usePreformMaterials, usePreformOperators } from "@/components/preform/api";
import {
  MOVEMENT_LABEL,
  STOCK_STATUS_LABEL,
  isPieceUnit,
  stockStatus,
  summarize,
  useFactorySuppliers,
  usePreformInventoryLive,
  usePreformOverview,
  useReconciliation,
} from "@/components/preform-inventory/api";
import {
  CountDialog,
  PreformFormDialog,
  ReceiveDialog,
} from "@/components/preform-inventory/dialogs";
import {
  CountsPanel,
  DeliveriesPanel,
  ReconciliationPanel,
} from "@/components/preform-inventory/panels";
import { ReportsPanel } from "@/components/preform-inventory/reports";

const TABS = ["stock", "deliveries", "counts", "reconciliation", "reports"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/preform-inventory")({
  head: () => ({
    meta: [
      { title: "Preform Inventory — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.includes(s.tab as Tab) ? (s.tab as Tab) : undefined,
  }),
  component: () => (
    <>
      <SectionTabs section="Store" />
      <RequireAccess module="raw-materials" anyOf={["preform-production", "goods-receiving"]}>
        <PreformInventoryPage />
      </RequireAccess>
    </>
  ),
});

type StockFilter = "all" | "positive" | "zero" | "negative" | "low" | "pending";

const STATUS_VARIANT = {
  negative: "destructive",
  out: "outline",
  low: "secondary",
  ok: "default",
} as const;

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "primary",
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  tone?: "primary" | "warning" | "destructive";
  onClick?: () => void;
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card
      className={`rounded-2xl ${onClick ? "cursor-pointer transition-colors hover:bg-muted/40" : ""}`}
      onClick={onClick}
    >
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

// Store → Preform Inventory: every preform specification, its stock in
// pieces / bags, deliveries by supplier, issues to the blowing line, counts
// and reconciliation. Stock only changes through the server workflows
// (supabase/migrations/20261020190000_preform_inventory.sql and the
// receipt / issue / adjustment functions it builds on).
function PreformInventoryPage() {
  const { data: factoryId } = useFactoryId();
  const { can } = usePermissions();
  usePreformInventoryLive();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const current = tab ?? "stock";
  const goTo = (t: Tab) =>
    navigate({ search: { tab: t === "stock" ? undefined : t }, replace: true, state: (p) => p });

  const since = addDays(localDay(), -30);
  const overview = usePreformOverview(factoryId, since);
  const recon = useReconciliation(factoryId);
  const suppliers = useFactorySuppliers(factoryId);
  const pfMaterials = usePreformMaterials(factoryId);
  const operators = usePreformOperators(factoryId);
  const rows = useMemo(() => overview.data ?? [], [overview.data]);
  const summary = summarize(rows);
  const discrepancies = (recon.data ?? []).filter((r) => r.severity !== "info").length;

  const canRegister = can("raw-materials", "create") || can("raw-materials", "submit");
  const canReceive = can("goods-receiving", "submit");
  const canIssue = can("preform-production", "post");
  const canCount = can("raw-materials", "submit");
  const canExport = can("raw-materials", "export") || can("preform-production", "export");

  const [dialog, setDialog] = useState<
    | { kind: "add" }
    | { kind: "receive"; materialId?: string }
    | { kind: "issue"; materialId?: string }
    | { kind: "count"; materialId?: string }
    | null
  >(null);

  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState("all");
  const [location, setLocation] = useState("all");
  const [stock, setStock] = useState<StockFilter>("all");
  const [activeFilter, setActiveFilter] = useState("active");
  const locations = useMemo(
    () => [...new Set(rows.map((r) => r.storage_location).filter(Boolean) as string[])].sort(),
    [rows],
  );
  const filtered = rows.filter((r) => {
    const term = q.trim().toLowerCase();
    const st = stockStatus(r);
    return (
      (!term ||
        [r.name, r.material_code, r.specification].some((v) =>
          (v ?? "").toLowerCase().includes(term),
        )) &&
      (supplier === "all" || r.suppliers.some((s) => s.id === supplier)) &&
      (location === "all" || r.storage_location === location) &&
      (activeFilter === "all" || (activeFilter === "active") === r.active) &&
      (stock === "all" ||
        (stock === "positive" && r.current_stock > 0) ||
        (stock === "zero" && r.current_stock === 0) ||
        (stock === "negative" && st === "negative") ||
        (stock === "low" && (st === "low" || st === "out")) ||
        (stock === "pending" && r.pending_receipt_count > 0))
    );
  });

  const exportTable = () =>
    exportCsv(
      `preform-stock-${localDay()}`,
      [
        { key: "code", label: "Material code" },
        { key: "name", label: "Preform" },
        { key: "spec", label: "Specification" },
        { key: "suppliers", label: "Suppliers" },
        { key: "pieces", label: "Stock (pieces)" },
        { key: "per_bag", label: "Pieces per bag" },
        { key: "bags", label: "Full bags" },
        { key: "loose", label: "Loose pieces" },
        { key: "pending", label: "Pending confirmation" },
        { key: "status", label: "Reorder status" },
        { key: "value", label: "Value" },
        { key: "last", label: "Last movement" },
      ],
      filtered.map((r) => {
        const s = splitBags(r.current_stock, r.pieces_per_bag);
        return {
          code: r.material_code,
          name: r.name,
          spec: r.specification,
          suppliers: r.suppliers.map((x) => x.name).join("; "),
          pieces: r.current_stock,
          per_bag: r.pieces_per_bag ?? "n/a",
          bags: s ? s.bags : "n/a",
          loose: s ? s.pieces : "n/a",
          pending: r.pending_receipt_qty,
          status: STOCK_STATUS_LABEL[stockStatus(r)],
          value: r.current_value,
          last: r.last_movement_at,
        };
      }),
    );

  if (!factoryId) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Preform Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Preform specifications, stock in pieces and bags, deliveries by supplier, issues to
            production and reconciliation. Stock is kept in pieces and changes only through posted
            transactions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRegister && (
            <Button className="gap-2" onClick={() => setDialog({ kind: "add" })}>
              <Plus className="h-4 w-4" /> Add preform
            </Button>
          )}
          {canReceive && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setDialog({ kind: "receive" })}
            >
              <PackagePlus className="h-4 w-4" /> Receive preforms
            </Button>
          )}
          {canIssue && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setDialog({ kind: "issue" })}
            >
              <Send className="h-4 w-4" /> Issue to production
            </Button>
          )}
          {canCount && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setDialog({ kind: "count" })}
            >
              <ClipboardList className="h-4 w-4" /> Stock count
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <SummaryCard
          icon={Boxes}
          label="Stock in pieces"
          value={num(summary.totalPieces)}
          hint={`Value ${money(summary.totalValue)}${summary.nonPieceSpecs ? ` · ${summary.nonPieceSpecs} not in pieces, excluded` : ""}`}
        />
        <SummaryCard
          icon={Layers}
          label="Full bags on hand"
          value={num(summary.fullBags)}
          hint={
            summary.bagSizes > 1
              ? `Mixed bag sizes (${summary.bagSizes}) — a count of bags, not a quantity`
              : "Plus loose pieces"
          }
        />
        <SummaryCard
          icon={ClipboardCheck}
          label="Active specifications"
          value={num(summary.activeSpecs)}
          hint={`${rows.length - summary.activeSpecs} inactive`}
        />
        <SummaryCard
          icon={Truck}
          label="Pending receipts"
          value={num(summary.pendingReceipts)}
          hint={`${num(summary.pendingReceiptPieces)} pcs awaiting Store`}
          tone={summary.pendingReceipts ? "warning" : "primary"}
          onClick={() => goTo("deliveries")}
        />
        <SummaryCard
          icon={PackageMinus}
          label="Issued to production"
          value={num(summary.issuedPieces)}
          hint="Pieces, last 30 days"
        />
        <SummaryCard
          icon={AlertTriangle}
          label="Discrepancies"
          value={num(discrepancies)}
          hint="Errors and warnings to investigate"
          tone={discrepancies ? "destructive" : "primary"}
          onClick={() => goTo("reconciliation")}
        />
      </div>

      <Tabs value={current} onValueChange={(v) => goTo(v as Tab)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          <TabsTrigger value="counts">Counts &amp; adjustments</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="stock">
          <Card className="rounded-2xl">
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Preform stock</CardTitle>
                {canExport && (
                  <Button size="sm" variant="outline" className="gap-1" onClick={exportTable}>
                    <Download className="h-4 w-4" /> Export
                  </Button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <div className="relative lg:col-span-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Name, code, specification…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <Select value={supplier} onValueChange={setSupplier}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All suppliers</SelectItem>
                    {(suppliers.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={location} onValueChange={setLocation}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All locations</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={stock} onValueChange={(v) => setStock(v as StockFilter)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any stock</SelectItem>
                    <SelectItem value="positive">In stock</SelectItem>
                    <SelectItem value="zero">Zero stock</SelectItem>
                    <SelectItem value="low">Low / out of stock</SelectItem>
                    <SelectItem value="pending">Pending confirmation</SelectItem>
                    <SelectItem value="negative">Negative (reconcile)</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={activeFilter} onValueChange={setActiveFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="all">Active &amp; inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Preform</TableHead>
                    <TableHead>Suppliers</TableHead>
                    <TableHead className="text-right">Stock (pcs)</TableHead>
                    <TableHead className="text-right">Pcs/bag</TableHead>
                    <TableHead className="text-right">Full bags</TableHead>
                    <TableHead className="text-right">Loose</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead>Reorder status</TableHead>
                    <TableHead>Last movement</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                        {overview.isLoading
                          ? "Loading…"
                          : rows.length
                            ? "No preform matches these filters."
                            : "No preforms registered yet."}
                      </TableCell>
                    </TableRow>
                  )}
                  {filtered.map((r) => {
                    const st = stockStatus(r);
                    const split = splitBags(r.current_stock, r.pieces_per_bag);
                    return (
                      <TableRow key={r.id} className={r.active ? "" : "opacity-60"}>
                        <TableCell className="font-mono text-xs">
                          {r.material_code ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Link
                            to="/preform-inventory/$materialId"
                            params={{ materialId: r.id }}
                            className="font-medium hover:underline"
                          >
                            {r.name}
                          </Link>
                          {r.specification && (
                            <div className="text-[11px] text-muted-foreground">
                              {r.specification}
                            </div>
                          )}
                          {!r.active && (
                            <Badge variant="outline" className="mt-1">
                              Inactive
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="max-w-44 text-xs">
                          {r.suppliers.length === 0 ? (
                            <span className="text-muted-foreground">None linked</span>
                          ) : (
                            r.suppliers.map((s) => (
                              <div
                                key={s.id}
                                className={s.active ? "" : "text-muted-foreground line-through"}
                              >
                                {s.name}
                                {s.preferred && <span className="text-primary"> ★</span>}
                              </div>
                            ))
                          )}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {num(r.current_stock)}
                          {!isPieceUnit(r.unit) && (
                            <div className="text-[11px] font-normal text-muted-foreground">
                              {r.unit}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.pieces_per_bag ? (
                            num(r.pieces_per_bag)
                          ) : (
                            <span className="text-[11px] text-muted-foreground">n/a</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {split ? num(split.bags) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {split ? num(split.pieces) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.pending_receipt_qty ? (
                            <span className="text-warning">{num(r.pending_receipt_qty)}</span>
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[st]} className="whitespace-nowrap">
                            {STOCK_STATUS_LABEL[st]}
                          </Badge>
                          {r.reorder_level > 0 && (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              reorder at {num(r.reorder_level)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {r.last_movement_type
                            ? (MOVEMENT_LABEL[r.last_movement_type] ?? r.last_movement_type)
                            : "—"}
                          <div className="text-muted-foreground">
                            {r.last_movement_at
                              ? fmtDateTime(r.last_movement_at)
                              : `Updated ${fmtDateTime(r.updated_at)}`}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {canReceive && r.active && (
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Receive"
                                onClick={() => setDialog({ kind: "receive", materialId: r.id })}
                              >
                                <PackagePlus className="h-4 w-4" />
                              </Button>
                            )}
                            {canIssue && r.active && r.pieces_per_bag && r.current_stock > 0 && (
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Issue to production"
                                onClick={() => setDialog({ kind: "issue", materialId: r.id })}
                              >
                                <Send className="h-4 w-4" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" title="History" asChild>
                              <Link
                                to="/preform-inventory/$materialId"
                                params={{ materialId: r.id }}
                                search={{ tab: "ledger" }}
                              >
                                <History className="h-4 w-4" />
                              </Link>
                            </Button>
                            <Button size="sm" variant="outline" asChild>
                              <Link
                                to="/preform-inventory/$materialId"
                                params={{ materialId: r.id }}
                              >
                                View
                              </Link>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deliveries">
          <DeliveriesPanel factoryId={factoryId} preforms={rows} />
        </TabsContent>
        <TabsContent value="counts">
          <CountsPanel
            factoryId={factoryId}
            onCount={canCount ? () => setDialog({ kind: "count" }) : undefined}
          />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationPanel
            factoryId={factoryId}
            onCount={canCount ? (id) => setDialog({ kind: "count", materialId: id }) : undefined}
          />
        </TabsContent>
        <TabsContent value="reports">
          <ReportsPanel factoryId={factoryId} preforms={rows} />
        </TabsContent>
      </Tabs>

      {dialog?.kind === "add" && (
        <PreformFormDialog factoryId={factoryId} editing={null} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "receive" && (
        <ReceiveDialog
          factoryId={factoryId}
          preforms={rows}
          initialMaterialId={dialog.materialId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "issue" && (
        <IssueDialog
          materials={pfMaterials.data ?? []}
          operators={operators.data ?? []}
          initialMaterialId={dialog.materialId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "count" && (
        <CountDialog
          preforms={rows.filter((r) => r.active)}
          initialMaterialId={dialog.materialId}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
