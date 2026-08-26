import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Printer, Eye, Ban, FileStack, Loader2, PackagePlus } from "lucide-react";
import { num, money } from "@/lib/format";
import { toast } from "sonner";
import { generatePurchaseOrderPdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";

export const Route = createFileRoute("/_app/purchase-orders")({
  head: () => ({ meta: [{ title: "Purchase Orders — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="purchase-orders">
      <PurchaseOrdersPage />
    </RequireAccess>
  ),
});

type ApprovedRequest = {
  id: string; request_number: string; quantity_requested: number; unit: string | null;
  supplier_id: string | null; material_id: string;
  raw_materials: { name: string; unit: string } | null;
  suppliers: { name: string } | null;
};

type PoRow = {
  id: string; po_number: string; purchase_request_id: string; supplier_id: string | null; material_id: string;
  quantity_ordered: number; quantity_received: number; unit: string | null; unit_cost: number | null;
  expected_delivery_date: string | null; status: string; notes: string | null;
  issued_by_name: string; issued_at: string; cancel_reason: string | null;
  approved_by_name: string | null; total_amount: number | null;
  raw_materials: { name: string; unit: string } | null;
  suppliers: { name: string; phone: string | null; address: string | null } | null;
  production_requests: { request_number: string } | null;
};

const statusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "received") return "secondary";
  if (s === "cancelled") return "destructive";
  if (s === "partially_received") return "default";
  return "outline";
};

function PurchaseOrdersPage() {
  const { data: factoryId } = useFactoryId();
  const { canCreate, canCancel, canSubmit } = usePermissions();
  const createPerm = canCreate("purchase-orders");
  const cancelPerm = canCancel("purchase-orders");
  const receivePerm = canSubmit("goods-receiving");
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<PoRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<PoRow | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<PoRow | null>(null);

  const approvedRequests = useQuery({
    queryKey: ["approved-purchase-requests-without-po", factoryId],
    enabled: !!factoryId && createOpen,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_requests")
        .select("id,request_number,quantity_requested,unit,supplier_id,material_id,raw_materials(name,unit),suppliers(name)")
        .eq("factory_id", factoryId!)
        .eq("request_type", "purchase")
        .eq("approval_status", "approved")
        .is("po_number", null)
        .order("approval_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ApprovedRequest[];
    },
  });

  const list = useQuery({
    queryKey: ["purchase-orders-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("id,po_number,purchase_request_id,supplier_id,material_id,quantity_ordered,quantity_received,unit,unit_cost,expected_delivery_date,status,notes,issued_by_name,issued_at,cancel_reason,approved_by_name,total_amount,raw_materials(name,unit),suppliers(name,phone,address),production_requests(request_number)")
        .eq("factory_id", factoryId!)
        .order("issued_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as PoRow[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["purchase-orders-list"] });
    qc.invalidateQueries({ queryKey: ["approved-purchase-requests-without-po"] });
    qc.invalidateQueries({ queryKey: ["production-requests-list"] });
  };

  const printPo = (row: PoRow) => {
    generatePurchaseOrderPdf(
      {
        company: { name: settings.data?.company_name ?? "FMIS", address: settings.data?.address, phone: settings.data?.phone, email: settings.data?.email, logo_url: settings.data?.logo_url },
        po_number: row.po_number,
        issued_at: new Date(row.issued_at).toLocaleString(),
        issued_by_name: row.issued_by_name,
        supplier: row.suppliers,
        material_name: row.raw_materials?.name ?? "—",
        quantity_ordered: Number(row.quantity_ordered),
        quantity_received: Number(row.quantity_received),
        unit: row.unit ?? row.raw_materials?.unit ?? "",
        unit_cost: row.unit_cost != null ? Number(row.unit_cost) : null,
        expected_delivery_date: row.expected_delivery_date,
        status: row.status,
        notes: row.notes,
      },
      "print",
    );
    logAudit({ action: "print", entity: "purchase_orders", entityId: row.id, factoryId });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchase Orders</h1>
          <p className="text-sm text-muted-foreground">Formal, auto-numbered orders issued against approved purchase requests — Goods Receiving matches deliveries against these.</p>
        </div>
        {createPerm && (
          <Button className="gap-2" onClick={() => setCreateOpen(true)}><FileStack className="h-4 w-4" /> Issue Purchase Order</Button>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>Orders</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Material</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.po_number}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{new Date(row.issued_at).toLocaleDateString()}</TableCell>
                  <TableCell className="font-medium">{row.raw_materials?.name ?? "—"}</TableCell>
                  <TableCell>{row.suppliers?.name ?? "—"}</TableCell>
                  <TableCell className="text-right">{num(Number(row.quantity_ordered))} {row.unit}</TableCell>
                  <TableCell className="text-right">{num(Number(row.quantity_received))} {row.unit}</TableCell>
                  <TableCell><Badge variant={statusBadge(row.status)} className="capitalize">{row.status.replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {receivePerm && (row.status === "issued" || row.status === "partially_received") && (
                        <Button variant="ghost" size="icon" title="Receive goods" onClick={() => setReceiveTarget(row)}>
                          <PackagePlus className="h-4 w-4 text-success" />
                        </Button>
                      )}
                      {cancelPerm && (row.status === "issued" || row.status === "partially_received") && (
                        <Button variant="ghost" size="icon" title="Cancel" onClick={() => setCancelTarget(row)}>
                          <Ban className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title="View" onClick={() => setDetailTarget(row)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Print" onClick={() => printPo(row)}>
                        <Printer className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No purchase orders yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {createOpen && (
          <CreatePoDialog
            candidates={approvedRequests.data ?? []}
            onDone={() => { setCreateOpen(false); invalidateAll(); }}
          />
        )}
      </Dialog>
      <Dialog open={!!receiveTarget} onOpenChange={(v) => !v && setReceiveTarget(null)}>
        {receiveTarget && <ReceiveDialog row={receiveTarget} onDone={() => { setReceiveTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && <CancelDialog row={cancelTarget} onDone={() => { setCancelTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!detailTarget} onOpenChange={(v) => !v && setDetailTarget(null)}>
        {detailTarget && <DetailDialog row={detailTarget} />}
      </Dialog>
    </div>
  );
}

function CreatePoDialog({ candidates, onDone }: { candidates: ApprovedRequest[]; onDone: () => void }) {
  const [requestId, setRequestId] = useState("");
  const [issuedByName, setIssuedByName] = useState("");
  const [quantity, setQuantity] = useState<number | "">("");
  const [unitCost, setUnitCost] = useState<number | "">("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");

  const selected = candidates.find((c) => c.id === requestId);

  const submit = useMutation({
    mutationFn: async () => {
      if (!requestId) throw new Error("Select an approved purchase request");
      if (!issuedByName.trim()) throw new Error("Enter your name");
      const { data, error } = await supabase.rpc("create_purchase_order", {
        payload: {
          purchase_request_id: requestId, issued_by_name: issuedByName.trim(),
          quantity_ordered: quantity === "" ? undefined : quantity,
          unit_cost: unitCost === "" ? undefined : unitCost,
          expected_delivery_date: expectedDate || undefined,
          notes: notes || undefined,
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (data) => {
      toast.success(`Purchase order ${data?.po_number ?? ""} issued`);
      logAudit({ action: "create", entity: "purchase_orders", entityId: data?.id });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>Issue Purchase Order</DialogTitle></DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No approved purchase requests are awaiting a purchase order right now.</p>
        ) : (
          <>
            <div>
              <Label>Approved purchase request</Label>
              <Select
                value={requestId}
                onValueChange={(v) => {
                  setRequestId(v);
                  const r = candidates.find((c) => c.id === v);
                  setQuantity(r ? Number(r.quantity_requested) : "");
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select request…" /></SelectTrigger>
                <SelectContent>
                  {candidates.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.request_number} · {r.raw_materials?.name} · {num(Number(r.quantity_requested))} {r.unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selected && (
              <p className="text-xs text-muted-foreground">
                Material: {selected.raw_materials?.name} · Requested supplier: {selected.suppliers?.name ?? "—"}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Quantity to order</Label><Input type="number" min={0.001} step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value === "" ? "" : Number(e.target.value))} /></div>
              <div><Label>Unit cost</Label><Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value === "" ? "" : Number(e.target.value))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Expected delivery date</Label><Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></div>
              <div><Label>Issued by</Label><Input value={issuedByName} onChange={(e) => setIssuedByName(e.target.value)} placeholder="Your name" /></div>
            </div>
            <div><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </>
        )}
      </div>
      {candidates.length > 0 && (
        <DialogFooter>
          <Button disabled={submit.isPending || !requestId || !issuedByName.trim()} onClick={() => submit.mutate()} className="gap-2">
            {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileStack className="h-4 w-4" />}
            {submit.isPending ? "Issuing…" : "Issue Purchase Order"}
          </Button>
        </DialogFooter>
      )}
    </DialogContent>
  );
}

function ReceiveDialog({ row, onDone }: { row: PoRow; onDone: () => void }) {
  const outstanding = Number(row.quantity_ordered) - Number(row.quantity_received);
  const [quantity, setQuantity] = useState(outstanding);
  const [damagedQuantity, setDamagedQuantity] = useState(0);
  const [unitCost, setUnitCost] = useState<number | "">(row.unit_cost != null ? Number(row.unit_cost) : "");
  const [deliveryReference, setDeliveryReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const accepted = Math.max(quantity - damagedQuantity, 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      if (quantity > outstanding) throw new Error(`Cannot exceed the ${num(outstanding)} ${row.unit ?? ""} still outstanding`);
      if (damagedQuantity < 0 || damagedQuantity > quantity) throw new Error("Damaged quantity must be between 0 and the received quantity");
      const { error } = await supabase.rpc("submit_goods_receipt", {
        payload: {
          purchase_order_id: row.id, quantity, damaged_quantity: damagedQuantity,
          unit_cost: unitCost === "" ? undefined : unitCost,
          delivery_reference: deliveryReference || undefined, remarks: remarks || undefined,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Submitted — awaiting confirmation by a different person"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Receive Goods — {row.po_number}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          {row.raw_materials?.name} · {num(outstanding)} {row.unit} outstanding of {num(Number(row.quantity_ordered))} {row.unit} ordered.
          Dual control: this only posts to stock once someone else confirms it.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Quantity received</Label><Input type="number" min={0.001} max={outstanding} step="0.001" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></div>
          <div><Label>Damaged quantity</Label><Input type="number" min={0} max={quantity} step="0.001" value={damagedQuantity} onChange={(e) => setDamagedQuantity(Number(e.target.value))} /></div>
        </div>
        <p className="text-xs text-muted-foreground">Accepted quantity: {num(accepted)} {row.unit} — only this posts to stock; damaged goes to the damage ledger.</p>
        <div><Label>Unit cost</Label><Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value === "" ? "" : Number(e.target.value))} /></div>
        <div><Label>Delivery reference</Label><Input value={deliveryReference} onChange={(e) => setDeliveryReference(e.target.value)} placeholder="Waybill / delivery note number" /></div>
        <div><Label>Remarks</Label><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || quantity <= 0 || damagedQuantity > quantity} onClick={() => submit.mutate()}>{submit.isPending ? "Submitting…" : "Submit for Confirmation"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelDialog({ row, onDone }: { row: PoRow; onDone: () => void }) {
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_purchase_order", { p_id: row.id, p_reason: reason || undefined });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Purchase order cancelled");
      logAudit({ action: "update", entity: "purchase_orders", entityId: row.id, newValue: { status: "cancelled", reason } });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Cancel — {row.po_number}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{row.raw_materials?.name} · {num(Number(row.quantity_ordered))} {row.unit}</p>
        <div><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Cancelling…" : "Cancel Purchase Order"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DetailDialog({ row }: { row: PoRow }) {
  return (
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>{row.po_number}</DialogTitle></DialogHeader>
      <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div><span className="text-muted-foreground">Material:</span> {row.raw_materials?.name ?? "—"}</div>
          <div><span className="text-muted-foreground">Supplier:</span> {row.suppliers?.name ?? "—"}</div>
          <div><span className="text-muted-foreground">Ordered:</span> {num(Number(row.quantity_ordered))} {row.unit}</div>
          <div><span className="text-muted-foreground">Received:</span> {num(Number(row.quantity_received))} {row.unit}</div>
          <div><span className="text-muted-foreground">Unit cost:</span> {row.unit_cost != null ? num(Number(row.unit_cost)) : "—"}</div>
          <div><span className="text-muted-foreground">Total:</span> {row.total_amount != null ? money(Number(row.total_amount)) : "—"}</div>
          <div><span className="text-muted-foreground">Status:</span> <Badge variant={statusBadge(row.status)} className="capitalize">{row.status.replace(/_/g, " ")}</Badge></div>
          <div><span className="text-muted-foreground">Expected delivery:</span> {row.expected_delivery_date ?? "—"}</div>
          <div><span className="text-muted-foreground">Created by:</span> {row.issued_by_name}</div>
          <div><span className="text-muted-foreground">Approved by:</span> {row.approved_by_name ?? "—"}</div>
          <div><span className="text-muted-foreground">Issued:</span> {new Date(row.issued_at).toLocaleString()}</div>
          <div><span className="text-muted-foreground">From request:</span> {row.production_requests?.request_number ?? "—"}</div>
        </div>
        {row.notes && <div><span className="text-muted-foreground">Notes:</span> {row.notes}</div>}
        {row.cancel_reason && <div><span className="text-muted-foreground">Cancel reason:</span> {row.cancel_reason}</div>}
      </div>
    </DialogContent>
  );
}
