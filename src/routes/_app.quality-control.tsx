import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SupplierPicker } from "@/components/shared/supplier-picker";
import {
  BagQty,
  BagQuantityInput,
  BagSizeSetup,
  CostPerBagInput,
  isPreform,
} from "@/components/shared/bag-quantity";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { num } from "@/lib/format";
import { toast } from "sonner";
import { ClipboardCheck, PackageCheck, Search } from "lucide-react";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useCurrentUserName } from "@/lib/use-current-user";
import { AddMaterialDialog, MaterialCombobox } from "@/components/shared/material-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QcJugRegister } from "@/components/qc/jug-register";
import { BottleTrackingPanel } from "@/components/qc/bottle-tracking";
import { GoodBottlesPanel } from "@/components/qc/good-bottles";
import { usePreformLive, useShiftReport, useStockings } from "@/components/preform/api";
import { localDay } from "@/lib/production-shift";
import { PAGES, usePageAccess } from "@/lib/page-access";

// Quality Control: supplier deliveries are inspected here before they can
// reach the Store. Each inspection is a goods receipt (the existing
// goods-receiving workflow): QC records what arrived and how much failed
// inspection, then the Store confirms it on the Raw Materials page,
// which posts only the passed quantity to stock. Failed quantity goes to
// the damage ledger. Dual control still applies -- whoever records the
// inspection can't be the one who confirms it.
//
// Stock material ordered on a purchase order is listed on the Purchase
// Orders tab; QC inspects each delivery from there and releases the passed
// quantity to the Store. Procurement's "Receive goods" lands here (?po=).
//
// Good bottles (blown bottles waiting to be stocked) and Bottle tracking
// (returnable containers) moved here from the Warehouse, which keeps track of
// finished products only. Each tab follows its own module and page access
// (src/lib/nav.ts → Quality Control), so e.g. a user with only distribution
// sees just Bottle tracking.
const QC_TABS = ["orders", "inspections", "jugs", "good-bottles", "bottle-tracking"] as const;
type QcTab = (typeof QC_TABS)[number];

export const Route = createFileRoute("/_app/quality-control")({
  head: () => ({
    meta: [{ title: "Quality Control — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  validateSearch: (s: Record<string, unknown>): { po?: string; tab?: QcTab } => ({
    po: typeof s.po === "string" && s.po ? s.po : undefined,
    tab: QC_TABS.includes(s.tab as QcTab) ? (s.tab as QcTab) : undefined,
  }),
  component: () => (
    <RequireAccess module="goods-receiving" anyOf={["preform-production", "distribution"]}>
      <QualityControlPage />
    </RequireAccess>
  ),
});

type Material = {
  id: string;
  name: string;
  unit: string;
  unit_cost: number;
  supplier_id: string | null;
  pieces_per_bag?: number | null;
};
type Supplier = { id: string; name: string };
type OpenOrder = {
  id: string;
  po_number: string;
  material_id: string;
  supplier_id: string | null;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number | null;
};
type PoStockRow = OpenOrder & {
  unit: string | null;
  status: string;
  issued_at: string;
  expected_delivery_date: string | null;
  raw_materials: { name: string; unit: string } | null;
  suppliers: { name: string } | null;
};
type Inspection = {
  id: string;
  receipt_number: string;
  quantity: number;
  damaged_quantity: number;
  accepted_quantity: number;
  unit: string | null;
  status: string;
  delivery_reference: string | null;
  remarks: string | null;
  reject_reason: string | null;
  submitted_at: string;
  raw_materials: { name: string } | null;
  suppliers: { name: string } | null;
};

const STATUS_LABELS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending_confirmation: { label: "Awaiting store", variant: "secondary" },
  confirmed: { label: "Confirmed", variant: "default" },
  posted: { label: "In store", variant: "default" },
  rejected: { label: "Rejected by store", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

// Quantity already released by QC against each PO but not yet confirmed by
// the Store. The PO's quantity_received only moves on confirmation, so this
// is held back from what QC can still release.
function usePendingByOrder(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["qc-po-pending", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("purchase_order_id,quantity")
        .eq("factory_id", factoryId!)
        .eq("status", "pending_confirmation")
        .not("purchase_order_id", "is", null);
      if (error) throw error;
      const byOrder: Record<string, number> = {};
      for (const r of data ?? []) {
        const id = r.purchase_order_id as string;
        byOrder[id] = (byOrder[id] ?? 0) + Number(r.quantity);
      }
      return byOrder;
    },
  });
}

function QualityControlPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { canSubmit, canCancel } = usePermissions();
  const submit = canSubmit("goods-receiving");
  const cancel = canCancel("goods-receiving");
  const { po, tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { canPage } = usePageAccess();
  const pageOk = (label: string) => {
    const p = PAGES.find((x) => x.entry === "Quality Control" && x.label === label);
    return !!p && canPage(p);
  };
  const tabs: QcTab[] = [
    ...(pageOk("Inspections") ? (["orders", "inspections", "jugs"] as const) : []),
    ...(pageOk("Good bottles") ? (["good-bottles"] as const) : []),
    ...(pageOk("Bottle tracking") ? (["bottle-tracking"] as const) : []),
  ];
  const showInspections = tabs.includes("orders");
  const current = tab && tabs.includes(tab) ? tab : tabs[0];
  const setTab = (t: QcTab) =>
    navigate({ search: { tab: t === tabs[0] ? undefined : t }, replace: true });
  usePreformLive();
  // Good bottles needing QC: shifts to inspect plus stockings to count in.
  const bottlesFactory = tabs.includes("good-bottles") ? factoryId : undefined;
  const waitingQc = useShiftReport(bottlesFactory, {
    from: "2000-01-01",
    to: localDay(),
    status: "awaiting_inspection",
  });
  const waitingStock = useStockings(bottlesFactory, "sent");
  const bottlesWaiting = (waitingQc.data?.length ?? 0) + (waitingStock.data?.length ?? 0);
  const [open, setOpen] = useState(!!po);
  const [releaseOrderId, setReleaseOrderId] = useState<string | undefined>(po);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  useRealtimeInvalidate(
    ["goods_receipts", "purchase_orders"],
    [["qc-inspections"], ["qc-po-stock"], ["qc-po-pending"], ["qc-open-orders"]],
  );

  const openDialog = (orderId?: string) => {
    setReleaseOrderId(orderId);
    setOpen(true);
  };
  const closeDialog = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setReleaseOrderId(undefined);
      if (po) navigate({ search: { tab }, replace: true });
    }
  };

  const inspections = useQuery({
    queryKey: ["qc-inspections", factoryId],
    enabled: !!factoryId && showInspections,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select(
          "id,receipt_number,quantity,damaged_quantity,accepted_quantity,unit,status,delivery_reference,remarks,reject_reason,submitted_at,raw_materials(name),suppliers(name)",
        )
        .eq("factory_id", factoryId!)
        .order("submitted_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Inspection[];
    },
  });

  const cancelInspection = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_goods_receipt", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Inspection cancelled");
      qc.invalidateQueries({ queryKey: ["qc-inspections"] });
      qc.invalidateQueries({ queryKey: ["goods-receipts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (inspections.data ?? []).filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (!term ||
          r.receipt_number.toLowerCase().includes(term) ||
          (r.raw_materials?.name ?? "").toLowerCase().includes(term) ||
          (r.suppliers?.name ?? "").toLowerCase().includes(term) ||
          (r.delivery_reference ?? "").toLowerCase().includes(term)),
    );
  }, [inspections.data, q, status]);

  const awaiting = (inspections.data ?? []).filter((r) => r.status === "pending_confirmation");
  const passedTotal = (inspections.data ?? [])
    .filter((r) => r.status === "posted")
    .reduce((s, r) => s + Number(r.accepted_quantity), 0);
  const failedTotal = (inspections.data ?? [])
    .filter((r) => r.status === "posted")
    .reduce((s, r) => s + Number(r.damaged_quantity), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Quality Control</h1>
          <p className="text-sm text-muted-foreground">
            Inspect stock material ordered on purchase orders and release what passes to the Store,
            stock good blown bottles and track returnable bottles.
          </p>
        </div>
        {submit && showInspections && (
          <Dialog open={open} onOpenChange={closeDialog}>
            <DialogTrigger asChild>
              <Button className="gap-2" onClick={() => setReleaseOrderId(undefined)}>
                <ClipboardCheck className="h-4 w-4" /> Record Inspection
              </Button>
            </DialogTrigger>
            {open && factoryId && (
              <InspectionDialog
                factoryId={factoryId}
                initialOrderId={releaseOrderId}
                onDone={() => {
                  closeDialog(false);
                  setTab("inspections");
                  qc.invalidateQueries({ queryKey: ["qc-inspections"] });
                  qc.invalidateQueries({ queryKey: ["qc-po-pending"] });
                  qc.invalidateQueries({ queryKey: ["goods-receipts"] });
                }}
              />
            )}
          </Dialog>
        )}
      </div>

      {tabs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          None of the Quality Control tabs are open to your account.
        </p>
      )}
      <Tabs value={current} onValueChange={(v) => setTab(v as QcTab)}>
        <TabsList className="h-auto flex-wrap">
          {showInspections && (
            <>
              <TabsTrigger value="orders">Purchase Orders</TabsTrigger>
              <TabsTrigger value="inspections">Inspections</TabsTrigger>
              <TabsTrigger value="jugs">Old &amp; New Jugs</TabsTrigger>
            </>
          )}
          {tabs.includes("good-bottles") && (
            <TabsTrigger value="good-bottles">
              Good bottles
              {bottlesWaiting > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">
                  {bottlesWaiting}
                </Badge>
              )}
            </TabsTrigger>
          )}
          {tabs.includes("bottle-tracking") && (
            <TabsTrigger value="bottle-tracking">Bottle tracking</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="good-bottles">
          {factoryId && <GoodBottlesPanel factoryId={factoryId} />}
        </TabsContent>
        <TabsContent value="bottle-tracking">
          <BottleTrackingPanel />
        </TabsContent>
        <TabsContent value="orders">
          {factoryId && (
            <PoStockPanel factoryId={factoryId} canRelease={submit} onRelease={openDialog} />
          )}
        </TabsContent>
        <TabsContent value="jugs">
          {factoryId && <QcJugRegister factoryId={factoryId} />}
        </TabsContent>
        <TabsContent value="inspections" className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="rounded-2xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Awaiting store
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{awaiting.length}</CardContent>
            </Card>
            <Card className="rounded-2xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Passed &amp; in store
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{num(passedTotal)}</CardContent>
            </Card>
            <Card className="rounded-2xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Failed inspection
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{num(failedTotal)}</CardContent>
            </Card>
          </div>

          <Card className="rounded-2xl">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle>Inspections</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="w-56 pl-8"
                    placeholder="Search material, supplier, ref…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {Object.entries(STATUS_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ref</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Material</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Delivered</TableHead>
                    <TableHead className="text-right">Passed</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                        {inspections.isLoading ? "Loading…" : "No inspections yet."}
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => {
                    const s = STATUS_LABELS[r.status] ?? {
                      label: r.status,
                      variant: "outline" as const,
                    };
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">
                          {r.receipt_number}
                          {r.delivery_reference && (
                            <div className="text-muted-foreground">{r.delivery_reference}</div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {new Date(r.submitted_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>{r.raw_materials?.name ?? "—"}</TableCell>
                        <TableCell>{r.suppliers?.name ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          {num(r.quantity)} {r.unit}
                        </TableCell>
                        <TableCell className="text-right">{num(r.accepted_quantity)}</TableCell>
                        <TableCell className="text-right">
                          {Number(r.damaged_quantity) > 0 ? (
                            <span className="text-destructive">{num(r.damaged_quantity)}</span>
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell className="max-w-xs text-xs text-muted-foreground">
                          {r.status === "rejected" && r.reject_reason
                            ? `Store: ${r.reject_reason}`
                            : (r.remarks ?? "")}
                        </TableCell>
                        <TableCell>
                          <Badge variant={s.variant}>{s.label}</Badge>
                        </TableCell>
                        <TableCell>
                          {cancel && r.status === "pending_confirmation" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={cancelInspection.isPending}
                              onClick={() => cancelInspection.mutate(r.id)}
                            >
                              Cancel
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Stock material on open purchase orders, waiting for QC. Each delivery is
// inspected and released from here; what's released but not yet confirmed
// by the Store shows as "Awaiting store" and can't be released twice.
function PoStockPanel({
  factoryId,
  canRelease,
  onRelease,
}: {
  factoryId: string;
  canRelease: boolean;
  onRelease: (orderId: string) => void;
}) {
  const [q, setQ] = useState("");
  const orders = useQuery({
    queryKey: ["qc-po-stock", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select(
          "id,po_number,material_id,supplier_id,quantity_ordered,quantity_received,unit,unit_cost,status,issued_at,expected_delivery_date,raw_materials(name,unit),suppliers(name)",
        )
        .eq("factory_id", factoryId)
        .in("status", ["issued", "partially_received"])
        .order("issued_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PoStockRow[];
    },
  });
  const pending = usePendingByOrder(factoryId);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (orders.data ?? []).filter(
      (r) =>
        !term ||
        r.po_number.toLowerCase().includes(term) ||
        (r.raw_materials?.name ?? "").toLowerCase().includes(term) ||
        (r.suppliers?.name ?? "").toLowerCase().includes(term),
    );
  }, [orders.data, q]);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Stock material on purchase orders</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Inspect each delivery and release the passed quantity to the Store.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="w-56 pl-8"
            placeholder="Search PO, material, supplier…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PO Number</TableHead>
              <TableHead>Material</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">In store</TableHead>
              <TableHead className="text-right">Awaiting store</TableHead>
              <TableHead className="text-right">To inspect</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {orders.isLoading
                    ? "Loading…"
                    : orders.isError
                      ? "Couldn't load purchase orders."
                      : "No open purchase orders waiting for inspection."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => {
              const unit = r.unit ?? r.raw_materials?.unit ?? "";
              const awaiting = pending.data?.[r.id] ?? 0;
              const toInspect = Math.max(
                Number(r.quantity_ordered) - Number(r.quantity_received) - awaiting,
                0,
              );
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.po_number}</TableCell>
                  <TableCell className="font-medium">{r.raw_materials?.name ?? "—"}</TableCell>
                  <TableCell>{r.suppliers?.name ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {r.expected_delivery_date
                      ? new Date(r.expected_delivery_date).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(Number(r.quantity_ordered))} {unit}
                  </TableCell>
                  <TableCell className="text-right">{num(Number(r.quantity_received))}</TableCell>
                  <TableCell className="text-right">
                    {awaiting > 0 ? <Badge variant="secondary">{num(awaiting)}</Badge> : "0"}
                  </TableCell>
                  <TableCell className="text-right font-semibold">{num(toInspect)}</TableCell>
                  <TableCell>
                    {canRelease && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={toInspect <= 0}
                        title={
                          toInspect <= 0
                            ? "Everything on this PO is already released — waiting for the Store"
                            : undefined
                        }
                        onClick={() => onRelease(r.id)}
                      >
                        <PackageCheck className="h-4 w-4" /> Inspect &amp; Release
                      </Button>
                    )}
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

function InspectionDialog({
  factoryId,
  initialOrderId,
  onDone,
}: {
  factoryId: string;
  initialOrderId?: string;
  onDone: () => void;
}) {
  const { canSubmit } = usePermissions();
  const qc = useQueryClient();
  // Whoever can record an inspection can also add a material that isn't in
  // the list yet; it's saved to the raw materials list for every later entry.
  const canAddMaterial = canSubmit("goods-receiving");
  const currentUserName = useCurrentUserName();
  // Every raw material, inactive ones too (marked), so any delivery can be
  // inspected.
  const materials = useQuery({
    queryKey: ["qc-materials", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,unit_cost,supplier_id,active,pieces_per_bag")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []).map(({ active, ...m }) => ({
        ...m,
        name: active ? m.name : `${m.name} (inactive)`,
      })) as Material[];
    },
  });
  const suppliers = useQuery({
    queryKey: ["suppliers-brief", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Supplier[];
    },
  });
  // Optional: users without purchase-order access just get an empty list
  // and record the delivery without linking it.
  const orders = useQuery({
    queryKey: ["qc-open-orders", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("id,po_number,material_id,supplier_id,quantity_ordered,quantity_received,unit_cost")
        .eq("factory_id", factoryId)
        .in("status", ["issued", "partially_received"])
        .order("issued_at", { ascending: false });
      if (error) return [] as OpenOrder[];
      return (data ?? []) as OpenOrder[];
    },
  });

  const [orderId, setOrderId] = useState("none");
  const [materialId, setMaterialId] = useState("");
  const [supplierId, setSupplierId] = useState("none");
  const [quantity, setQuantity] = useState(0);
  const [failedQuantity, setFailedQuantity] = useState(0);
  const [unitCost, setUnitCost] = useState(0);
  const [deliveryReference, setDeliveryReference] = useState("");
  const [inspectedBy, setInspectedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [addMaterialName, setAddMaterialName] = useState<string | null>(null);
  // Materials added from this form, usable before the list refetches.
  const [addedMaterials, setAddedMaterials] = useState<Material[]>([]);
  const allMaterials = [
    ...(materials.data ?? []),
    ...addedMaterials.filter((a) => !(materials.data ?? []).some((m) => m.id === a.id)),
  ];

  // The inspector is the signed-in user unless they type someone else.
  useEffect(() => {
    if (!inspectedBy && currentUserName.data) setInspectedBy(currentUserName.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserName.data]);

  const pending = usePendingByOrder(factoryId);
  // Opened from a purchase order: preselect it once the open orders load.
  useEffect(() => {
    if (initialOrderId && orderId === "none" && orders.data?.some((o) => o.id === initialOrderId))
      pickOrder(initialOrderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId, orders.data]);

  const order = (orders.data ?? []).find((o) => o.id === orderId);
  const material = allMaterials.find((m) => m.id === materialId);
  // Preforms are received in bags (stock is kept in pieces). A preform with
  // no bag size gets it set here before the delivery is entered.
  const [savedPerBag, setSavedPerBag] = useState<Record<string, number>>({});
  const perBag = material ? (savedPerBag[material.id] ?? material.pieces_per_bag ?? null) : null;
  const needsBagSize = !!material && isPreform(material.name) && !perBag;
  const outstanding = order
    ? Math.max(
        Number(order.quantity_ordered) -
          Number(order.quantity_received) -
          (pending.data?.[order.id] ?? 0),
        0,
      )
    : null;
  const passed = Math.max(quantity - failedQuantity, 0);

  const pickOrder = (id: string) => {
    setOrderId(id);
    const o = (orders.data ?? []).find((x) => x.id === id);
    if (!o) return;
    setMaterialId(o.material_id);
    if (o.supplier_id) setSupplierId(o.supplier_id);
    if (o.unit_cost != null) setUnitCost(Number(o.unit_cost));
  };
  const pickMaterial = (id: string) => {
    setMaterialId(id);
    const m = allMaterials.find((x) => x.id === id);
    if (!m) return;
    setUnitCost(Number(m.unit_cost));
    if (m.supplier_id && supplierId === "none") setSupplierId(m.supplier_id);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!materialId) throw new Error("Select the material inspected");
      if (quantity <= 0) throw new Error("Delivered quantity must be > 0");
      if (failedQuantity < 0 || failedQuantity > quantity)
        throw new Error("Failed quantity must be between 0 and the delivered quantity");
      if (outstanding != null && quantity > outstanding)
        throw new Error(
          `Only ${num(outstanding)} is still to be inspected on this purchase order (the rest is released and awaiting the Store)`,
        );
      if (!inspectedBy.trim()) throw new Error("Enter the inspector's name");
      const remarks = [`QC inspected by ${inspectedBy.trim()}`, notes.trim()]
        .filter(Boolean)
        .join(" — ");
      const { error } = await supabase.rpc("submit_goods_receipt", {
        payload: {
          purchase_order_id: order ? order.id : null,
          material_id: materialId,
          quantity,
          damaged_quantity: failedQuantity,
          unit_cost: unitCost,
          supplier_id: supplierId === "none" ? null : supplierId,
          delivery_reference: deliveryReference || null,
          remarks,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Inspected and released — awaiting Store confirmation");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {order ? `Inspect & Release — ${order.po_number}` : "Record Inspection"}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        {(orders.data ?? []).length > 0 && (
          <div>
            <Label>Purchase order (optional)</Label>
            <Select value={orderId} onValueChange={pickOrder}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Not linked to a PO —</SelectItem>
                {(orders.data ?? []).map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.po_number} ·{" "}
                    {allMaterials.find((m) => m.id === o.material_id)?.name ?? "Material"} ·{" "}
                    {num(
                      Math.max(
                        Number(o.quantity_ordered) -
                          Number(o.quantity_received) -
                          (pending.data?.[o.id] ?? 0),
                        0,
                      ),
                    )}{" "}
                    to inspect
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label>Material</Label>
          <MaterialCombobox
            value={materialId}
            materials={allMaterials}
            onChange={pickMaterial}
            onAddNew={canAddMaterial ? (query) => setAddMaterialName(query) : undefined}
            disabled={!!order}
          />
          {canAddMaterial && !order && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Not in the list? Type its name and choose &quot;Add as a new material&quot; —
              it&apos;s saved for every inspection after this.
            </p>
          )}
        </div>
        <div>
          <Label>Supplier</Label>
          <SupplierPicker
            factoryId={factoryId}
            suppliers={suppliers.data ?? []}
            value={supplierId}
            onChange={setSupplierId}
          />
        </div>
        {needsBagSize && material && (
          <BagSizeSetup
            materialId={material.id}
            materialName={material.name}
            onSaved={(n) => {
              setSavedPerBag((prev) => ({ ...prev, [material.id]: n }));
              qc.invalidateQueries({ queryKey: ["qc-materials"] });
            }}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <BagQuantityInput
            label={perBag ? "Bags delivered" : "Quantity delivered"}
            value={quantity}
            onChange={setQuantity}
            perBag={perBag}
            unit={material?.unit}
            disabled={needsBagSize}
          />
          <BagQuantityInput
            label={perBag ? "Failed (bags)" : "Quantity failed"}
            value={failedQuantity}
            onChange={setFailedQuantity}
            perBag={perBag}
            unit={material?.unit}
            disabled={needsBagSize}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Passed: <BagQty value={passed} unit={material?.unit} perBag={perBag} bagsFirst /> Only
          this goes into the Store. Failed quantity is written off to the damage ledger.
          {outstanding != null && ` ${num(outstanding)} still to inspect on this PO.`}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <CostPerBagInput
            unitCost={unitCost}
            onChange={setUnitCost}
            perBag={perBag}
            unit={material?.unit}
          />
          <div>
            <Label>Delivery reference</Label>
            <Input
              value={deliveryReference}
              onChange={(e) => setDeliveryReference(e.target.value)}
              placeholder="Waybill / delivery note"
            />
          </div>
        </div>
        <div>
          <Label>Inspected by</Label>
          <Input
            value={inspectedBy}
            onChange={(e) => setInspectedBy(e.target.value)}
            placeholder="Inspector's name"
          />
        </div>
        <div>
          <Label>Inspection notes</Label>
          <Textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Checks done, reasons for any failed quantity…"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={
            save.isPending ||
            !materialId ||
            needsBagSize ||
            quantity <= 0 ||
            failedQuantity > quantity
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Releasing…" : "Release to Store"}
        </Button>
      </DialogFooter>

      <Dialog open={addMaterialName != null} onOpenChange={(v) => !v && setAddMaterialName(null)}>
        {addMaterialName != null && (
          <AddMaterialDialog
            factoryId={factoryId}
            initialName={addMaterialName}
            // Stock arrives through this inspection, not as an opening balance.
            canSetStock={false}
            onCreated={(mat) => {
              setAddedMaterials((prev) => [...prev, { ...mat, unit_cost: 0, supplier_id: null }]);
              pickMaterial(mat.id);
              setAddMaterialName(null);
            }}
          />
        )}
      </Dialog>
    </DialogContent>
  );
}
