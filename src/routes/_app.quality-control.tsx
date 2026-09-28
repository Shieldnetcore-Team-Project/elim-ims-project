import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
import { ClipboardCheck, Search } from "lucide-react";
import { useRealtimeInvalidate } from "@/lib/realtime";

// Quality Control: supplier deliveries are inspected here before they can
// reach the warehouse. Each inspection is a goods receipt (the existing
// goods-receiving workflow): QC records what arrived and how much failed
// inspection, then the warehouse confirms it on the Raw Materials page,
// which posts only the passed quantity to stock. Failed quantity goes to
// the damage ledger. Dual control still applies -- whoever records the
// inspection can't be the one who confirms it.
export const Route = createFileRoute("/_app/quality-control")({
  head: () => ({
    meta: [{ title: "Quality Control — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="goods-receiving">
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

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending_confirmation: { label: "Awaiting warehouse", variant: "secondary" },
  confirmed: { label: "Confirmed", variant: "default" },
  posted: { label: "In warehouse", variant: "default" },
  rejected: { label: "Rejected by warehouse", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

function QualityControlPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { canSubmit, canCancel } = usePermissions();
  const submit = canSubmit("goods-receiving");
  const cancel = canCancel("goods-receiving");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  useRealtimeInvalidate(["goods_receipts"], [["qc-inspections"]]);

  const inspections = useQuery({
    queryKey: ["qc-inspections", factoryId],
    enabled: !!factoryId,
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
            Inspect supplier deliveries. Passed quantity goes to the warehouse once it confirms
            receipt; failed quantity is written off.
          </p>
        </div>
        {submit && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <ClipboardCheck className="h-4 w-4" /> Record Inspection
              </Button>
            </DialogTrigger>
            {open && factoryId && (
              <InspectionDialog
                factoryId={factoryId}
                onDone={() => {
                  setOpen(false);
                  qc.invalidateQueries({ queryKey: ["qc-inspections"] });
                  qc.invalidateQueries({ queryKey: ["goods-receipts"] });
                }}
              />
            )}
          </Dialog>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Awaiting warehouse
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{awaiting.length}</CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Passed &amp; in warehouse
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
                const s = STATUS_LABELS[r.status] ?? { label: r.status, variant: "outline" as const };
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
                        ? `Warehouse: ${r.reject_reason}`
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
    </div>
  );
}

function InspectionDialog({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
  const materials = useQuery({
    queryKey: ["qc-materials", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,unit_cost,supplier_id")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Material[];
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

  const order = (orders.data ?? []).find((o) => o.id === orderId);
  const material = (materials.data ?? []).find((m) => m.id === materialId);
  const outstanding = order ? Number(order.quantity_ordered) - Number(order.quantity_received) : null;
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
    const m = (materials.data ?? []).find((x) => x.id === id);
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
        throw new Error(`Only ${num(outstanding)} is still outstanding on this purchase order`);
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
      toast.success("Inspection recorded — sent to the warehouse for confirmation");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Record Inspection</DialogTitle>
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
                    {(materials.data ?? []).find((m) => m.id === o.material_id)?.name ?? "Material"}{" "}
                    · {num(Number(o.quantity_ordered) - Number(o.quantity_received))} outstanding
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label>Material</Label>
          <Select value={materialId} onValueChange={pickMaterial} disabled={!!order}>
            <SelectTrigger>
              <SelectValue placeholder="Select material" />
            </SelectTrigger>
            <SelectContent>
              {(materials.data ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Supplier</Label>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {(suppliers.data ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Quantity delivered</Label>
            <MoneyInput min={0.001} step="0.001" value={quantity} onChange={setQuantity} />
          </div>
          <div>
            <Label>Quantity failed</Label>
            <MoneyInput
              min={0}
              max={quantity}
              step="0.001"
              value={failedQuantity}
              onChange={setFailedQuantity}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Passed: {num(passed)} {material?.unit ?? ""} — only this goes into the warehouse. Failed
          quantity is written off to the damage ledger.
          {outstanding != null && ` ${num(outstanding)} outstanding on this PO.`}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Unit cost</Label>
            <MoneyInput value={unitCost} onChange={setUnitCost} />
          </div>
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
          <Input value={inspectedBy} onChange={(e) => setInspectedBy(e.target.value)} />
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
          disabled={save.isPending || !materialId || quantity <= 0 || failedQuantity > quantity}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Submitting…" : "Send to Warehouse"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
