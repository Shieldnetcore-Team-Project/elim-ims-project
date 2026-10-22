import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Download, PackagePlus, Pencil, Send, Star } from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SupplierPicker } from "@/components/shared/supplier-picker";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { addDays, localDay } from "@/lib/production-shift";
import { money, num } from "@/lib/format";
import { formatBags, splitBags } from "@/lib/preform-units";
import { exportCsv } from "@/lib/export";
import { CountInput, fmtDate, fmtDateTime, StatusBadge } from "@/components/preform/shared";
import { IssueDialog } from "@/components/preform/issues";
import {
  db,
  rpc,
  usePreformMaterials,
  usePreformOperators,
  useUserNames,
} from "@/components/preform/api";
import {
  MOVEMENT_LABEL,
  STOCK_STATUS_LABEL,
  stockStatus,
  useFactorySuppliers,
  useIssueLines,
  useMaterialLedger,
  usePinvAction,
  usePreformInventoryLive,
  usePreformOverview,
  usePreformReceipts,
} from "@/components/preform-inventory/api";
import {
  CountDialog,
  PreformFormDialog,
  ReceiveDialog,
} from "@/components/preform-inventory/dialogs";
import { DeliveriesPanel } from "@/components/preform-inventory/panels";

const TABS = ["overview", "ledger", "suppliers", "issues", "costing"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/preform-inventory_/$materialId")({
  head: () => ({
    meta: [{ title: "Preform — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.includes(s.tab as Tab) ? (s.tab as Tab) : undefined,
  }),
  component: () => (
    <>
      <SectionTabs section="Store" />
      <RequireAccess module="raw-materials" anyOf={["preform-production", "goods-receiving"]}>
        <PreformDetailPage />
      </RequireAccess>
    </>
  ),
});

type SupplierLink = {
  id: string;
  supplier_id: string;
  supplier_item_code: string | null;
  pieces_per_bag: number | null;
  is_preferred: boolean;
  active: boolean;
  notes: string | null;
  suppliers: { name: string } | null;
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-1.5 text-xl font-semibold">{value}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function PreformDetailPage() {
  const { materialId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const current = tab ?? "overview";
  const goTo = (t: Tab) =>
    navigate({ search: { tab: t === "overview" ? undefined : t }, replace: true, state: (p) => p });
  const { data: factoryId } = useFactoryId();
  const { can } = usePermissions();
  usePreformInventoryLive();
  const overview = usePreformOverview(factoryId, addDays(localDay(), -30));
  const all = overview.data ?? [];
  const m = all.find((r) => r.id === materialId);
  const pfMaterials = usePreformMaterials(factoryId);
  const operators = usePreformOperators(factoryId);
  const [dialog, setDialog] = useState<"edit" | "receive" | "issue" | "count" | null>(null);

  const canEdit = can("raw-materials", "edit") || can("preform-production", "reverse");
  const canReceive = can("goods-receiving", "submit");
  const canIssue = can("preform-production", "post");
  const canCount = can("raw-materials", "submit");

  if (!factoryId) return null;
  if (!m) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="py-10 text-center text-muted-foreground">
          {overview.isLoading ? "Loading…" : "This preform was not found."}
          <div className="mt-3">
            <Button variant="outline" asChild>
              <Link to="/preform-inventory">Back to Preform Inventory</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const split = splitBags(m.current_stock, m.pieces_per_bag);
  const st = stockStatus(m);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/preform-inventory"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
          >
            <ArrowLeft className="h-3 w-3" /> Preform Inventory
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {m.name}{" "}
            <span className="font-mono text-base text-muted-foreground">{m.material_code}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {m.specification && <span>{m.specification}</span>}
            <Badge
              variant={st === "ok" ? "default" : st === "negative" ? "destructive" : "secondary"}
            >
              {STOCK_STATUS_LABEL[st]}
            </Badge>
            {!m.active && <Badge variant="outline">Inactive</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button variant="outline" className="gap-2" onClick={() => setDialog("edit")}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          )}
          {canReceive && m.active && (
            <Button variant="outline" className="gap-2" onClick={() => setDialog("receive")}>
              <PackagePlus className="h-4 w-4" /> Receive
            </Button>
          )}
          {canIssue && m.active && m.pieces_per_bag && (
            <Button variant="outline" className="gap-2" onClick={() => setDialog("issue")}>
              <Send className="h-4 w-4" /> Issue
            </Button>
          )}
          {canCount && (
            <Button variant="outline" className="gap-2" onClick={() => setDialog("count")}>
              <ClipboardList className="h-4 w-4" /> Count
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Stat
          label="Available"
          value={`${num(m.current_stock)} pcs`}
          hint={split ? formatBags(split) : "Bag conversion not applicable"}
        />
        <Stat
          label="Pending confirmation"
          value={num(m.pending_receipt_qty)}
          hint={`${m.pending_receipt_count} deliveries awaiting the Store`}
        />
        <Stat
          label="Issued, awaiting operator"
          value={num(m.awaiting_ack_qty)}
          hint="Left the store, not yet acknowledged"
        />
        <Stat
          label="Held by production"
          value={num(m.production_held_qty)}
          hint="Accepted, not yet used"
        />
        <Stat
          label="Inventory value"
          value={money(m.current_value)}
          hint={`${money(m.avg_unit_cost)}/pc average`}
        />
        <Stat
          label="Pieces per bag"
          value={m.pieces_per_bag ? num(m.pieces_per_bag) : "n/a"}
          hint={m.reorder_level ? `Reorder at ${num(m.reorder_level)} pcs` : "No reorder level"}
        />
      </div>

      <Tabs value={current} onValueChange={(v) => goTo(v as Tab)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="overview">Material &amp; suppliers</TabsTrigger>
          <TabsTrigger value="ledger">Stock movements</TabsTrigger>
          <TabsTrigger value="suppliers">Supplier history</TabsTrigger>
          <TabsTrigger value="issues">Issues to production</TabsTrigger>
          <TabsTrigger value="costing">Costing</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="grid gap-4 lg:grid-cols-2">
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Material information</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                {(
                  [
                    ["Code", m.material_code],
                    ["Name", m.name],
                    ["Specification", m.specification],
                    ["Base unit", m.unit],
                    [
                      "Pieces per bag",
                      m.pieces_per_bag ? num(m.pieces_per_bag) : "Not delivered in bags",
                    ],
                    ["Reorder level", m.reorder_level ? `${num(m.reorder_level)} pcs` : "—"],
                    ["Storage location", m.storage_location],
                    ["Used by", m.production_department],
                    ["Status", m.active ? "Active" : "Inactive"],
                    ["Notes", m.remarks],
                  ] as [string, string | null][]
                ).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd>{v || "—"}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
          <SuppliersCard
            factoryId={factoryId}
            materialId={m.id}
            canManage={canEdit || can("raw-materials", "create")}
            specPerBag={m.pieces_per_bag}
          />
        </TabsContent>
        <TabsContent value="ledger">
          <LedgerCard materialId={m.id} name={m.name} perBag={m.pieces_per_bag} />
        </TabsContent>
        <TabsContent value="suppliers">
          <DeliveriesPanel factoryId={factoryId} preforms={all} materialId={m.id} />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesCard factoryId={factoryId} materialId={m.id} />
        </TabsContent>
        <TabsContent value="costing">
          <CostingCard
            factoryId={factoryId}
            materialId={m.id}
            perBag={m.pieces_per_bag}
            avg={m.avg_unit_cost}
            value={m.current_value}
            last={m.last_purchase_cost}
          />
        </TabsContent>
      </Tabs>

      {dialog === "edit" && (
        <PreformFormDialog factoryId={factoryId} editing={m} onClose={() => setDialog(null)} />
      )}
      {dialog === "receive" && (
        <ReceiveDialog
          factoryId={factoryId}
          preforms={all}
          initialMaterialId={m.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "issue" && (
        <IssueDialog
          materials={pfMaterials.data ?? []}
          operators={operators.data ?? []}
          initialMaterialId={m.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "count" && (
        <CountDialog preforms={all} initialMaterialId={m.id} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

// A supplier's own bag size for this preform. Blank = the specification's
// usual size. Changing it affects future deliveries only; each receipt keeps
// the size it was recorded with.
function BagSizeCell({
  value,
  specPerBag,
  canEdit,
  pending,
  onSave,
}: {
  value: number | null;
  specPerBag: number | null;
  canEdit: boolean;
  pending: boolean;
  onSave: (perBag: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const shown = value ? (
    num(value)
  ) : (
    <span className="text-muted-foreground">{specPerBag ? `${num(specPerBag)} (usual)` : "—"}</span>
  );
  if (!canEdit) return <span className="text-xs">{shown}</span>;
  if (!editing)
    return (
      <button
        type="button"
        className="text-xs hover:underline"
        title="Set this supplier's bag size"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {shown}
      </button>
    );
  return (
    <div className="flex items-center gap-1">
      <CountInput
        className="h-8 w-24"
        value={draft}
        onChange={setDraft}
        placeholder={specPerBag ? String(specPerBag) : "pcs/bag"}
      />
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          // Blank or the usual size = no supplier-specific size.
          onSave(!draft || draft === specPerBag ? 0 : draft);
          setEditing(false);
        }}
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}

function SuppliersCard({
  factoryId,
  materialId,
  canManage,
  specPerBag,
}: {
  factoryId: string;
  materialId: string;
  canManage: boolean;
  specPerBag: number | null;
}) {
  const suppliers = useFactorySuppliers(factoryId);
  const links = useQuery({
    queryKey: ["pinv", "links", materialId],
    queryFn: async () => {
      const { data, error } = await db
        .from("material_suppliers")
        .select(
          "id,supplier_id,supplier_item_code,pieces_per_bag,is_preferred,active,notes,suppliers(name)",
        )
        .eq("material_id", materialId)
        .order("is_preferred", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SupplierLink[];
    },
  });
  const [adding, setAdding] = useState("none");
  const [itemCode, setItemCode] = useState("");
  const save = usePinvAction(
    (a: {
      supplier: string;
      preferred: boolean;
      active: boolean;
      code: string | null;
      notes: string | null;
      // undefined keeps the supplier's bag size; 0 clears it.
      perBag?: number;
    }) =>
      rpc("save_material_supplier", {
        p_material: materialId,
        p_supplier: a.supplier,
        p_preferred: a.preferred,
        p_active: a.active,
        p_item_code: a.code,
        p_notes: a.notes,
        p_pieces_per_bag: a.perBag ?? null,
      }),
    "Supplier link saved",
  );
  const linked = new Set((links.data ?? []).map((l) => l.supplier_id));

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Suppliers of this preform</CardTitle>
        <p className="text-sm text-muted-foreground">
          The same specification can come from several suppliers; each delivery keeps its supplier
          and price. ★ = preferred (used for reorders and purchase orders).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead>Their item code</TableHead>
              <TableHead>Bag size</TableHead>
              <TableHead>Active</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(links.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  No supplier linked yet.
                </TableCell>
              </TableRow>
            )}
            {(links.data ?? []).map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  {l.suppliers?.name ?? "—"}
                  {l.is_preferred && (
                    <Star className="ml-1 inline h-3.5 w-3.5 fill-primary text-primary" />
                  )}
                </TableCell>
                <TableCell className="text-xs">{l.supplier_item_code ?? "—"}</TableCell>
                <TableCell>
                  <BagSizeCell
                    value={l.pieces_per_bag}
                    specPerBag={specPerBag}
                    canEdit={canManage}
                    pending={save.isPending}
                    onSave={(perBag) =>
                      save.mutate({
                        supplier: l.supplier_id,
                        preferred: l.is_preferred,
                        active: l.active,
                        code: l.supplier_item_code,
                        notes: l.notes,
                        perBag,
                      })
                    }
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={l.active}
                    disabled={!canManage || save.isPending || l.is_preferred}
                    onCheckedChange={(v) =>
                      save.mutate({
                        supplier: l.supplier_id,
                        preferred: l.is_preferred,
                        active: v,
                        code: l.supplier_item_code,
                        notes: l.notes,
                      })
                    }
                  />
                </TableCell>
                <TableCell className="text-right">
                  {canManage && !l.is_preferred && l.active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending}
                      onClick={() =>
                        save.mutate({
                          supplier: l.supplier_id,
                          preferred: true,
                          active: true,
                          code: l.supplier_item_code,
                          notes: l.notes,
                        })
                      }
                    >
                      Make preferred
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {canManage && (
          <div className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_auto_auto]">
            <SupplierPicker
              factoryId={factoryId}
              suppliers={(suppliers.data ?? []).filter((s) => !linked.has(s.id))}
              value={adding}
              onChange={setAdding}
            />
            <Input
              placeholder="Their item code (optional)"
              value={itemCode}
              onChange={(e) => setItemCode(e.target.value)}
            />
            <Button
              disabled={adding === "none" || save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    supplier: adding,
                    preferred: (links.data ?? []).length === 0,
                    active: true,
                    code: itemCode || null,
                    notes: null,
                  },
                  {
                    onSuccess: () => {
                      setAdding("none");
                      setItemCode("");
                    },
                  },
                )
              }
            >
              Link supplier
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LedgerCard({
  materialId,
  name,
  perBag,
}: {
  materialId: string;
  name: string;
  perBag: number | null;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const ledger = useMaterialLedger(materialId, from || undefined, to || undefined);
  const rows = ledger.data ?? [];
  const exportRows = () =>
    exportCsv(
      `${name.replace(/\W+/g, "-")}-movements-${localDay()}`,
      [
        { key: "date", label: "Date" },
        { key: "type", label: "Type" },
        { key: "reference", label: "Reference" },
        { key: "supplier", label: "Supplier" },
        { key: "quantity", label: "Quantity (+in / -out)" },
        { key: "before", label: "Balance before" },
        { key: "after", label: "Balance after" },
        { key: "unit_cost", label: "Unit cost" },
        { key: "by", label: "By" },
        { key: "reason", label: "Reason" },
      ],
      rows.map((r) => ({
        date: r.created_at,
        type: MOVEMENT_LABEL[r.movement_type] ?? r.movement_type,
        reference: r.reference,
        supplier: r.supplier_name,
        quantity: r.quantity,
        before: r.quantity_before,
        after: r.quantity_after,
        unit_cost: r.unit_cost,
        by: r.user_name,
        reason: r.reason,
      })),
    );
  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Stock movements</CardTitle>
          <p className="text-sm text-muted-foreground">
            Every posted change to store stock, newest first. Posted lines are never edited — a
            correction is a new line.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            type="date"
            className="w-36"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input type="date" className="w-36" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="outline" size="sm" className="gap-1" onClick={exportRows}>
            <Download className="h-4 w-4" /> Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead className="text-right">In / out</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {ledger.isLoading ? "Loading…" : "No movements."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => {
              const after = r.quantity_after;
              const s = after != null ? splitBags(after, perBag) : null;
              return (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDateTime(r.created_at)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {MOVEMENT_LABEL[r.movement_type] ?? r.movement_type}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.reference ?? <span className="text-destructive">missing</span>}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${r.quantity < 0 ? "text-destructive" : "text-primary"}`}
                  >
                    {r.quantity > 0 ? "+" : ""}
                    {num(r.quantity)}
                  </TableCell>
                  <TableCell className="text-right">
                    {after == null ? "—" : num(after)}
                    {s && <div className="text-[11px] text-muted-foreground">{formatBags(s)}</div>}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {r.unit_cost == null ? "—" : money(r.unit_cost)}
                  </TableCell>
                  <TableCell className="text-xs">{r.user_name ?? "—"}</TableCell>
                  <TableCell className="max-w-64 text-xs text-muted-foreground">
                    {r.supplier_name && <div className="text-foreground">{r.supplier_name}</div>}
                    {r.reason}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function IssuesCard({ factoryId, materialId }: { factoryId: string; materialId: string }) {
  const issues = useIssueLines(factoryId, addDays(localDay(), -365), localDay(), materialId);
  const names = useUserNames((issues.data ?? []).flatMap((i) => [i.operator_id, i.issued_by]));
  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Issues to production (last 12 months)</CardTitle>
          <p className="text-sm text-muted-foreground">
            QC accepts each issue on the Quality Control page (Good bottles).
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/preform-inventory" search={{ tab: "issues" }}>
            Issue preforms
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead className="text-right">Bags</TableHead>
              <TableHead className="text-right">Pieces</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Issued by</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(issues.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {issues.isLoading ? "Loading…" : "No issues in the last 12 months."}
                </TableCell>
              </TableRow>
            )}
            {(issues.data ?? []).map((i) => (
              <TableRow key={i.id}>
                <TableCell className="font-mono text-xs">{i.reference}</TableCell>
                <TableCell className="text-xs">{fmtDate(i.issue_date)}</TableCell>
                <TableCell>{names.data?.[i.operator_id] ?? "…"}</TableCell>
                <TableCell className="text-right">
                  {num(i.bags)}
                  {i.loose_pieces > 0 && (
                    <span className="text-xs text-muted-foreground"> + {num(i.loose_pieces)}</span>
                  )}
                  <div className="text-[11px] text-muted-foreground">× {num(i.pieces_per_bag)}</div>
                </TableCell>
                <TableCell className="text-right font-medium">{num(i.pieces)}</TableCell>
                <TableCell className="text-right text-xs">
                  {money(i.pieces * i.unit_cost)}
                </TableCell>
                <TableCell className="text-xs">{names.data?.[i.issued_by ?? ""] ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={i.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CostingCard({
  factoryId,
  materialId,
  perBag,
  avg,
  value,
  last,
}: {
  factoryId: string;
  materialId: string;
  perBag: number | null;
  avg: number;
  value: number;
  last: number | null;
}) {
  const receipts = usePreformReceipts(factoryId, { material: materialId });
  const priced = useMemo(
    () =>
      (receipts.data ?? []).filter(
        (r) => r.unit_cost != null && r.status !== "cancelled" && r.status !== "rejected",
      ),
    [receipts.data],
  );
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Valuation</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Method</dt>
            <dd>Moving weighted average</dd>
            <dt className="text-muted-foreground">Cost per piece</dt>
            <dd className="font-medium">{money(avg)}</dd>
            <dt className="text-muted-foreground">Cost per bag</dt>
            <dd>{perBag ? money(avg * perBag) : "n/a"}</dd>
            <dt className="text-muted-foreground">Inventory value</dt>
            <dd className="font-medium">{money(value)}</dd>
            <dt className="text-muted-foreground">Last purchase price</dt>
            <dd>{last == null ? "—" : `${money(last)}/pc`}</dd>
          </dl>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Each receipt adds at its own price; issues leave at the average at that moment. A new
            price changes the average from then on — past receipts, issues and production costs keep
            the cost they were posted with.
          </p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl lg:col-span-2">
        <CardHeader>
          <CardTitle>Purchase price history</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>GRN</TableHead>
                <TableHead className="text-right">Price/pc</TableHead>
                <TableHead className="text-right">Price/bag</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {priced.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    {receipts.isLoading ? "Loading…" : "No priced deliveries yet."}
                  </TableCell>
                </TableRow>
              )}
              {priced.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{fmtDate(r.delivery_date)}</TableCell>
                  <TableCell>{r.supplier_name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.receipt_number}</TableCell>
                  <TableCell className="text-right">{money(r.unit_cost)}</TableCell>
                  <TableCell className="text-right text-xs">
                    {r.pieces_per_bag ? money((r.unit_cost ?? 0) * r.pieces_per_bag) : "n/a"}
                  </TableCell>
                  <TableCell className="text-right">{num(r.accepted_quantity)}</TableCell>
                  <TableCell className="text-right text-xs">{money(r.accepted_value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
