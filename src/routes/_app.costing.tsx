import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { usePermissions } from "@/lib/permissions";
import { useFactoryId } from "@/lib/use-factory";
import { useHydratedFactoryCode } from "@/lib/factory-store";
import { money, num } from "@/lib/format";
import { logAudit } from "@/lib/audit";
import { WORKFLOW_STATUS_LABELS, type WorkflowStatus } from "@/lib/workflow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Trash2, Ban, Check, X, Pencil, Droplet, Package } from "lucide-react";

export const Route = createFileRoute("/_app/costing")({
  head: () => ({ meta: [{ title: "Costing — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="costing">
      <CostingPage />
    </RequireAccess>
  ),
});

// Water and Nylon are different product lines end to end (different factories,
// different materials, different worksheet math) and must never be mixed in
// one costing sheet — each gets its own dedicated form below, isolated from
// the other, filtered to its own tagged products/materials only.
type SheetType = "water" | "nylon";

type ProductRow = { id: string; name: string; unit: string; product_categories: { product_line: string | null } | null };
type MaterialRow = { id: string; name: string; unit: string; unit_cost: number; material_categories: { product_line: string | null } | null };

type Sheet = {
  id: string; sheet_number: string; product_id: string; sheet_type: SheetType | null; yield_quantity: number;
  material_cost: number; labor_cost: number; overhead_cost: number; overhead_percent: number | null;
  pack_quantity: number; pack_cost: number; cost_per_pack: number;
  total_cost: number; unit_cost: number; apply_to_product: boolean; is_applied: boolean;
  status: WorkflowStatus; created_by: string | null; notes: string | null; created_at: string;
  products: { name: string; unit: string } | null;
};

const statusBadge = (s: WorkflowStatus): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "posted") return "secondary";
  if (s === "rejected" || s === "cancelled") return "destructive";
  return "outline";
};

function PriceOptionsEditor({ priceOptions, setPriceOptions, costBasis }: {
  priceOptions: string[]; setPriceOptions: (v: string[]) => void; costBasis: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Proposed selling prices</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => setPriceOptions([...priceOptions, ""])}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add price
        </Button>
      </div>
      {priceOptions.map((p, i) => {
        const price = Number(p);
        const margin = price > 0 ? price - costBasis : null;
        return (
          <div key={i} className="flex items-center gap-2">
            <Input className="flex-1" type="number" min="0" step="0.01" placeholder="Proposed price" value={p}
              onChange={(e) => setPriceOptions(priceOptions.map((x, j) => (j === i ? e.target.value : x)))} />
            {margin !== null && (
              <span className={`w-32 shrink-0 text-xs ${margin >= 0 ? "text-success" : "text-destructive"}`}>
                margin {money(margin)} ({costBasis > 0 ? ((margin / costBasis) * 100).toFixed(1) : "0"}%)
              </span>
            )}
            <Button type="button" variant="ghost" size="icon" onClick={() => setPriceOptions(priceOptions.filter((_, j) => j !== i))} disabled={priceOptions.length === 1}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function CostingPage() {
  const qc = useQueryClient();
  const { canSubmit, canEdit, canCancel, canApprove, canReject } = usePermissions();
  const factory = useFactoryId();
  const factoryId = factory.data;
  const activeCode = useHydratedFactoryCode();
  const submitPerm = canSubmit("costing");
  const editPerm = canEdit("costing");
  const cancelPerm = canCancel("costing");
  const approvePerm = canApprove("costing");
  const rejectPerm = canReject("costing");

  const [showCreate, setShowCreate] = useState(false);
  const [editingSheet, setEditingSheet] = useState<Sheet | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Sheet | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const products = useQuery({
    queryKey: ["costing-products", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("products")
        .select("id,name,unit,product_categories(product_line)")
        .eq("factory_id", factoryId!).eq("active", true).order("name");
      if (error) throw error;
      return (data ?? []) as unknown as ProductRow[];
    },
  });

  const materials = useQuery({
    queryKey: ["costing-materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("raw_materials")
        .select("id,name,unit,unit_cost,material_categories(product_line)")
        .eq("factory_id", factoryId!).eq("active", true).eq("approval_status", "approved").order("name");
      if (error) throw error;
      return (data ?? []) as unknown as MaterialRow[];
    },
  });

  const waterProducts = (products.data ?? []).filter((p) => p.product_categories?.product_line === "water");
  const nylonProducts = (products.data ?? []).filter((p) => p.product_categories?.product_line === "nylon");
  const waterMaterials = (materials.data ?? []).filter((m) => m.material_categories?.product_line === "water");
  const nylonMaterials = (materials.data ?? []).filter((m) => m.material_categories?.product_line === "nylon");

  const sheets = useQuery({
    queryKey: ["costing-sheets", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("costing_sheets")
        .select("id,sheet_number,product_id,sheet_type,yield_quantity,material_cost,labor_cost,overhead_cost,overhead_percent,pack_quantity,pack_cost,cost_per_pack,total_cost,unit_cost,apply_to_product,is_applied,status,created_by,notes,created_at,products(name,unit)")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Sheet[];
    },
  });

  const pendingSheets = (sheets.data ?? []).filter((s) => s.status === "pending_approval");

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["costing-sheets"] });
    qc.invalidateQueries({ queryKey: ["costing-products"] });
  };

  const cancelSheet = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_costing_sheet", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Costing sheet cancelled"); invalidateAll(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const approveSheet = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("approve_costing_sheet", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Approved — cost applied to product"); invalidateAll(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectSheet = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reject_costing_sheet", { p_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Costing sheet rejected"); setRejectTarget(null); setRejectReason(""); invalidateAll(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const pageLabel = activeCode === "nylon" ? "Nylon Costing" : "Water Costing";
  const pageDesc = activeCode === "nylon"
    ? "Blended material cost, production overhead, and batch weight roll-ups for nylon bags — submitted for approval before applying to the live cost price."
    : "Preform, cap, label, content cost, and carton roll-ups for bottled water — submitted for approval before applying to the live cost price.";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{pageLabel}</h1>
          <p className="text-sm text-muted-foreground">{pageDesc}</p>
        </div>
        {submitPerm && activeCode && (
          <Button onClick={() => setShowCreate(true)}>
            {activeCode === "nylon" ? <Package className="mr-2 h-4 w-4" /> : <Droplet className="mr-2 h-4 w-4" />}
            New {activeCode === "nylon" ? "Nylon" : "Water"} Costing Sheet
          </Button>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>Costing history</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sheet #</TableHead><TableHead>Product</TableHead><TableHead>Yield</TableHead>
                <TableHead>Material</TableHead><TableHead>Unit Cost</TableHead><TableHead>Cost/Pack</TableHead>
                <TableHead>Applied</TableHead><TableHead>Status</TableHead><TableHead>Date</TableHead><TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sheets.data ?? []).map((s) => {
                const isSelf = s.created_by === currentUser.data;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.sheet_number}</TableCell>
                    <TableCell>{s.products?.name ?? "—"}</TableCell>
                    <TableCell>{num(s.yield_quantity)} {s.products?.unit}</TableCell>
                    <TableCell>{money(s.material_cost)}</TableCell>
                    <TableCell>{money(s.unit_cost)}</TableCell>
                    <TableCell className="font-medium">{money(s.cost_per_pack)}</TableCell>
                    <TableCell>{s.is_applied ? "Yes" : "No"}</TableCell>
                    <TableCell><Badge variant={statusBadge(s.status)}>{WORKFLOW_STATUS_LABELS[s.status]}</Badge></TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{new Date(s.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {s.status === "pending_approval" && (
                        <div className="flex justify-end gap-1">
                          {editPerm && isSelf && s.sheet_type && (
                            <Button variant="ghost" size="icon" title="Edit" onClick={() => setEditingSheet(s)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {cancelPerm && isSelf && (
                            <Button variant="ghost" size="icon" title="Cancel" onClick={() => cancelSheet.mutate(s.id)}>
                              <Ban className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(sheets.data?.length ?? 0) === 0 && (
                <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No costing sheets yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {pendingSheets.length > 0 && (approvePerm || rejectPerm) && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader><CardTitle>Pending Costing Sheets to Approve</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sheet #</TableHead><TableHead>Product</TableHead>
                  <TableHead className="text-right">Cost / Pack</TableHead><TableHead>Submitted</TableHead><TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingSheets.map((s) => {
                  const isSelf = s.created_by === currentUser.data;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.sheet_number}</TableCell>
                      <TableCell>{s.products?.name ?? "—"}</TableCell>
                      <TableCell className="text-right">{money(s.cost_per_pack)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(s.created_at).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {approvePerm && !isSelf && (
                            <Button variant="ghost" size="icon" title="Approve & Apply" onClick={() => approveSheet.mutate(s.id)}>
                              <Check className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {rejectPerm && !isSelf && (
                            <Button variant="ghost" size="icon" title="Reject" onClick={() => setRejectTarget(s)}>
                              <X className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {showCreate && activeCode === "water" && (
        <WaterCostingDialog
          factoryId={factoryId!} products={waterProducts} materials={waterMaterials} editing={null}
          onClose={() => setShowCreate(false)}
        />
      )}
      {showCreate && activeCode === "nylon" && (
        <NylonCostingDialog
          factoryId={factoryId!} products={nylonProducts} materials={nylonMaterials} editing={null}
          onClose={() => setShowCreate(false)}
        />
      )}
      {editingSheet?.sheet_type === "water" && (
        <WaterCostingDialog
          factoryId={factoryId!} products={waterProducts} materials={waterMaterials} editing={editingSheet}
          onClose={() => setEditingSheet(null)}
        />
      )}
      {editingSheet?.sheet_type === "nylon" && (
        <NylonCostingDialog
          factoryId={factoryId!} products={nylonProducts} materials={nylonMaterials} editing={editingSheet}
          onClose={() => setEditingSheet(null)}
        />
      )}

      <Dialog open={!!rejectTarget} onOpenChange={(v) => { if (!v) { setRejectTarget(null); setRejectReason(""); } }}>
        {rejectTarget && (
          <DialogContent>
            <DialogHeader><DialogTitle>Reject {rejectTarget.sheet_number}</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Explain what looks wrong…" />
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={!rejectReason.trim() || rejectSheet.isPending}
                onClick={() => rejectSheet.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
              >
                {rejectSheet.isPending ? "Rejecting…" : "Reject Sheet"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

// ============================================================================
// WATER — Preform → Cap → Label → Content cost % → Carton + Shrink wrapper
// ============================================================================
function WaterCostingDialog({ factoryId, products, materials, editing, onClose }: {
  factoryId: string; products: ProductRow[]; materials: MaterialRow[]; editing: Sheet | null; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [productId, setProductId] = useState(editing?.product_id ?? "");
  const [yieldQty, setYieldQty] = useState(editing ? String(editing.yield_quantity) : "");
  const [preformMaterialId, setPreformMaterialId] = useState("");
  const [preformQtyKg, setPreformQtyKg] = useState("");
  const [capMaterialId, setCapMaterialId] = useState("");
  const [labelMaterialId, setLabelMaterialId] = useState("");
  const [contentPercent, setContentPercent] = useState(editing?.overhead_percent != null ? String(editing.overhead_percent) : "10");
  const [bottlesPerCarton, setBottlesPerCarton] = useState(editing ? String(editing.pack_quantity) : "12");
  const [shrinkWrapCost, setShrinkWrapCost] = useState(editing ? String(editing.pack_cost) : "100");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [applyToProduct, setApplyToProduct] = useState(editing?.apply_to_product ?? true);
  const [priceOptions, setPriceOptions] = useState<string[]>([""]);
  const [loaded, setLoaded] = useState(!editing);

  useEffect(() => {
    if (!editing) return;
    (async () => {
      const { data: items } = await supabase.from("costing_sheet_items").select("material_id,quantity,role").eq("sheet_id", editing.id);
      const preform = (items ?? []).find((i) => i.role === "preform");
      const cap = (items ?? []).find((i) => i.role === "cap");
      const label = (items ?? []).find((i) => i.role === "label");
      if (preform) { setPreformMaterialId(preform.material_id); setPreformQtyKg(String(preform.quantity)); }
      if (cap) setCapMaterialId(cap.material_id);
      if (label) setLabelMaterialId(label.material_id);

      const { data: options } = await supabase.from("costing_price_options").select("proposed_price").eq("sheet_id", editing.id);
      setPriceOptions((options ?? []).length > 0 ? (options ?? []).map((o) => String(o.proposed_price)) : [""]);
      setLoaded(true);
    })();
  }, [editing?.id]);

  const yieldN = Number(yieldQty) || 0;
  const preformQty = Number(preformQtyKg) || 0;
  const preformUnitCost = materials.find((m) => m.id === preformMaterialId)?.unit_cost ?? 0;
  const capUnitCost = materials.find((m) => m.id === capMaterialId)?.unit_cost ?? 0;
  const labelUnitCost = materials.find((m) => m.id === labelMaterialId)?.unit_cost ?? 0;

  const preformTotalCost = preformQty * preformUnitCost;
  const preformCostPerPc = yieldN > 0 ? preformTotalCost / yieldN : 0;
  const materialCost = preformTotalCost + yieldN * capUnitCost + yieldN * labelUnitCost;
  const bottleMaterials = yieldN > 0 ? materialCost / yieldN : 0;
  const contentCost = bottleMaterials * (Number(contentPercent) || 0) / 100;
  const costPerBottle = bottleMaterials + contentCost;
  const bottlesPerCartonN = Number(bottlesPerCarton) || 12;
  const shrinkWrapCostN = Number(shrinkWrapCost) || 0;
  const costPerCartonBeforeWrap = costPerBottle * bottlesPerCartonN;
  const finalCostPerCarton = costPerCartonBeforeWrap + shrinkWrapCostN;

  const buildPayload = () => ({
    factory_id: factoryId,
    product_id: productId,
    sheet_type: "water",
    yield_quantity: yieldN,
    labor_cost: 0,
    overhead_cost: 0,
    overhead_percent: Number(contentPercent) || 0,
    pack_quantity: bottlesPerCartonN,
    pack_cost: shrinkWrapCostN,
    apply_to_product: applyToProduct,
    notes: notes || null,
    items: [
      { material_id: preformMaterialId, quantity: preformQty, role: "preform" },
      { material_id: capMaterialId, quantity: yieldN, role: "cap" },
      { material_id: labelMaterialId, quantity: yieldN, role: "label" },
    ].filter((i) => i.material_id && i.quantity > 0),
    price_options: priceOptions.filter((p) => p.trim() !== "" && Number(p) >= 0).map((p) => ({ proposed_price: Number(p) })),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      if (editing) {
        const { data, error } = await supabase.rpc("update_costing_sheet", { payload: { id: editing.id, ...payload } });
        if (error) throw error;
        return data as { id: string; unit_cost: number; cost_per_pack: number };
      }
      const { data, error } = await supabase.rpc("submit_costing_sheet", { payload });
      if (error) throw error;
      return data as { id: string; sheet_number: string; unit_cost: number; cost_per_pack: number };
    },
    onSuccess: (result: any) => {
      toast.success(editing ? "Water costing sheet updated" : `Submitted ${result.sheet_number} — awaiting approval`);
      logAudit({ action: editing ? "update" : "create", entity: "costing_sheets", entityId: result.id, factoryId, newValue: result });
      qc.invalidateQueries({ queryKey: ["costing-sheets"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmitForm = loaded && productId && yieldN > 0 && preformMaterialId && capMaterialId && labelMaterialId && preformQty > 0;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Droplet className="h-4 w-4 text-sky-500" /> {editing ? "Edit Water Costing Sheet" : "New Water Costing Sheet"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Product</Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger><SelectValue placeholder="Select water product" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                  {products.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No products tagged as Water yet.</div>}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Batch yield (bottles)</Label>
              <Input type="number" min="0" step="1" placeholder="e.g. 670" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} />
            </div>
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Preform</Label>
            <div className="grid grid-cols-2 gap-3">
              <Select value={preformMaterialId} onValueChange={setPreformMaterialId}>
                <SelectTrigger><SelectValue placeholder="Preform resin" /></SelectTrigger>
                <SelectContent>
                  {materials.map((m) => (<SelectItem key={m.id} value={m.id}>{m.name} ({money(m.unit_cost)}/{m.unit})</SelectItem>))}
                </SelectContent>
              </Select>
              <Input type="number" min="0" step="0.001" placeholder="Kg used for whole batch" value={preformQtyKg} onChange={(e) => setPreformQtyKg(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">Preform cost/pc = (kg used × cost/kg) ÷ batch yield = {money(preformCostPerPc)}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Cap</Label>
              <Select value={capMaterialId} onValueChange={setCapMaterialId}>
                <SelectTrigger><SelectValue placeholder="Bottle cap" /></SelectTrigger>
                <SelectContent>
                  {materials.map((m) => (<SelectItem key={m.id} value={m.id}>{m.name} ({money(m.unit_cost)}/{m.unit})</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Label</Label>
              <Select value={labelMaterialId} onValueChange={setLabelMaterialId}>
                <SelectTrigger><SelectValue placeholder="Label" /></SelectTrigger>
                <SelectContent>
                  {materials.map((m) => (<SelectItem key={m.id} value={m.id}>{m.name} ({money(m.unit_cost)}/{m.unit})</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">One cap and one label are assumed per bottle, scaled to the batch yield above.</p>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>Content cost %</Label>
              <Input type="number" min="0" step="0.01" value={contentPercent} onChange={(e) => setContentPercent(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Bottles / carton</Label>
              <Input type="number" min="1" step="1" value={bottlesPerCarton} onChange={(e) => setBottlesPerCarton(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Shrink wrapper (₦/carton)</Label>
              <Input type="number" min="0" step="0.01" value={shrinkWrapCost} onChange={(e) => setShrinkWrapCost(e.target.value)} />
            </div>
          </div>

          <PriceOptionsEditor priceOptions={priceOptions} setPriceOptions={setPriceOptions} costBasis={finalCostPerCarton} />

          <div className="space-y-2"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

          <div className="flex items-center gap-2">
            <Checkbox id="apply-water" checked={applyToProduct} onCheckedChange={(v) => setApplyToProduct(!!v)} />
            <Label htmlFor="apply-water" className="cursor-pointer">Apply computed cost per carton to this product's cost price once approved</Label>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Preform cost/pc</span><span>{money(preformCostPerPc)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Bottle materials (preform + cap + label)</span><span>{money(bottleMaterials)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Content cost ({contentPercent || 0}%)</span><span>{money(contentCost)}</span></div>
            <div className="flex justify-between border-t pt-1 mt-1"><span className="text-muted-foreground">Cost per bottle</span><span className="font-medium">{money(costPerBottle)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Cost per carton ({bottlesPerCartonN} bottles)</span><span>{money(costPerCartonBeforeWrap)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Shrink wrapper</span><span>{money(shrinkWrapCostN)}</span></div>
            <div className="flex justify-between border-t pt-1 mt-1"><span className="text-muted-foreground">Final cost per carton</span><span className="font-semibold">{money(finalCostPerCarton)}</span></div>
          </div>
          <p className="text-xs text-muted-foreground">Requires a second person's approval — this submits a request instead of changing the product's cost price immediately.</p>
        </div>
        <DialogFooter>
          <Button disabled={!canSubmitForm || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Saving…" : editing ? "Save changes" : "Submit for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// NYLON — Blended material cost/kg → Overhead % → Batch weight → Cost of production
// ============================================================================
type BlendLine = { material_id: string; quantity: string };

function NylonCostingDialog({ factoryId, products, materials, editing, onClose }: {
  factoryId: string; products: ProductRow[]; materials: MaterialRow[]; editing: Sheet | null; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [productId, setProductId] = useState(editing?.product_id ?? "");
  const [blendLines, setBlendLines] = useState<BlendLine[]>([{ material_id: "", quantity: "" }]);
  const [overheadPercent, setOverheadPercent] = useState(editing?.overhead_percent != null ? String(editing.overhead_percent) : "20");
  const [batchWeight, setBatchWeight] = useState(editing ? String(editing.pack_quantity) : "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [applyToProduct, setApplyToProduct] = useState(editing?.apply_to_product ?? true);
  const [priceOptions, setPriceOptions] = useState<string[]>([""]);
  const [loaded, setLoaded] = useState(!editing);

  useEffect(() => {
    if (!editing) return;
    (async () => {
      const { data: items } = await supabase.from("costing_sheet_items").select("material_id,quantity,role").eq("sheet_id", editing.id);
      const blend = (items ?? []).filter((i) => i.role === "blend" || !i.role);
      setBlendLines(blend.length > 0 ? blend.map((i) => ({ material_id: i.material_id, quantity: String(i.quantity) })) : [{ material_id: "", quantity: "" }]);

      const { data: options } = await supabase.from("costing_price_options").select("proposed_price").eq("sheet_id", editing.id);
      setPriceOptions((options ?? []).length > 0 ? (options ?? []).map((o) => String(o.proposed_price)) : [""]);
      setLoaded(true);
    })();
  }, [editing?.id]);

  const materialCost = blendLines.reduce((sum, l) => {
    const m = materials.find((x) => x.id === l.material_id);
    const qty = Number(l.quantity);
    return sum + (m && qty > 0 ? m.unit_cost * qty : 0);
  }, 0);
  const totalQty = blendLines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
  const blendedCostPerKg = totalQty > 0 ? materialCost / totalQty : 0;
  const overheadAmount = materialCost * (Number(overheadPercent) || 0) / 100;
  const totalWithOverhead = materialCost + overheadAmount;
  const costPerKgWithOverhead = totalQty > 0 ? totalWithOverhead / totalQty : 0;
  const batchWeightN = Number(batchWeight) || 0;
  const costOfProduction = costPerKgWithOverhead * batchWeightN;

  const buildPayload = () => ({
    factory_id: factoryId,
    product_id: productId,
    sheet_type: "nylon",
    yield_quantity: totalQty,
    labor_cost: 0,
    overhead_cost: 0,
    overhead_percent: Number(overheadPercent) || 0,
    pack_quantity: batchWeightN || 1,
    pack_cost: 0,
    apply_to_product: applyToProduct,
    notes: notes || null,
    items: blendLines
      .filter((l) => l.material_id && Number(l.quantity) > 0)
      .map((l) => ({ material_id: l.material_id, quantity: Number(l.quantity), role: "blend" })),
    price_options: priceOptions.filter((p) => p.trim() !== "" && Number(p) >= 0).map((p) => ({ proposed_price: Number(p) })),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      if (editing) {
        const { data, error } = await supabase.rpc("update_costing_sheet", { payload: { id: editing.id, ...payload } });
        if (error) throw error;
        return data as { id: string; unit_cost: number; cost_per_pack: number };
      }
      const { data, error } = await supabase.rpc("submit_costing_sheet", { payload });
      if (error) throw error;
      return data as { id: string; sheet_number: string; unit_cost: number; cost_per_pack: number };
    },
    onSuccess: (result: any) => {
      toast.success(editing ? "Nylon costing sheet updated" : `Submitted ${result.sheet_number} — awaiting approval`);
      logAudit({ action: editing ? "update" : "create", entity: "costing_sheets", entityId: result.id, factoryId, newValue: result });
      qc.invalidateQueries({ queryKey: ["costing-sheets"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmitForm = loaded && productId && batchWeightN > 0 && blendLines.some((l) => l.material_id && Number(l.quantity) > 0);

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Package className="h-4 w-4 text-amber-500" /> {editing ? "Edit Nylon Costing Sheet" : "New Nylon Costing Sheet"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Product</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger><SelectValue placeholder="Select nylon product" /></SelectTrigger>
              <SelectContent>
                {products.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                {products.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No products tagged as Nylon yet.</div>}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Blend components (Recycle, Moisturizer, Master Batch…)</Label>
              <Button type="button" variant="outline" size="sm" onClick={() => setBlendLines([...blendLines, { material_id: "", quantity: "" }])}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add component
              </Button>
            </div>
            {blendLines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={line.material_id} onValueChange={(v) => setBlendLines(blendLines.map((l, j) => (j === i ? { ...l, material_id: v } : l)))}>
                  <SelectTrigger className="flex-1"><SelectValue placeholder="Material" /></SelectTrigger>
                  <SelectContent>
                    {materials.map((m) => (<SelectItem key={m.id} value={m.id}>{m.name} ({money(m.unit_cost)}/{m.unit})</SelectItem>))}
                  </SelectContent>
                </Select>
                <Input className="w-28" type="number" min="0" step="0.001" placeholder="Kg" value={line.quantity}
                  onChange={(e) => setBlendLines(blendLines.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)))} />
                <Button type="button" variant="ghost" size="icon" onClick={() => setBlendLines(blendLines.filter((_, j) => j !== i))} disabled={blendLines.length === 1}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">Total blended: {num(totalQty)}kg — blended cost/kg = {money(blendedCostPerKg)}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Overhead % (production overhead)</Label>
              <Input type="number" min="0" step="0.01" value={overheadPercent} onChange={(e) => setOverheadPercent(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Batch weight (kg per bag-count)</Label>
              <Input type="number" min="0" step="0.001" placeholder="e.g. 13.5" value={batchWeight} onChange={(e) => setBatchWeight(e.target.value)} />
            </div>
          </div>

          <PriceOptionsEditor priceOptions={priceOptions} setPriceOptions={setPriceOptions} costBasis={costOfProduction} />

          <div className="space-y-2"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

          <div className="flex items-center gap-2">
            <Checkbox id="apply-nylon" checked={applyToProduct} onCheckedChange={(v) => setApplyToProduct(!!v)} />
            <Label htmlFor="apply-nylon" className="cursor-pointer">Apply computed cost of production to this product's cost price once approved</Label>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Blended raw material cost/kg</span><span>{money(blendedCostPerKg)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Overhead ({overheadPercent || 0}%)</span><span>{money(overheadAmount)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Cost/kg with overhead</span><span>{money(costPerKgWithOverhead)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Batch weight</span><span>{num(batchWeightN)}kg</span></div>
            <div className="flex justify-between border-t pt-1 mt-1"><span className="text-muted-foreground">Cost of production</span><span className="font-semibold">{money(costOfProduction)}</span></div>
          </div>
          <p className="text-xs text-muted-foreground">Requires a second person's approval — this submits a request instead of changing the product's cost price immediately.</p>
        </div>
        <DialogFooter>
          <Button disabled={!canSubmitForm || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Saving…" : editing ? "Save changes" : "Submit for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
