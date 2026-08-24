import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { usePermissions } from "@/lib/permissions";
import { useFactoryId } from "@/lib/use-factory";
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
import { Calculator, Plus, Trash2, Ban, Check, X, Pencil } from "lucide-react";

export const Route = createFileRoute("/_app/costing")({
  head: () => ({ meta: [{ title: "Costing — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="costing">
      <CostingPage />
    </RequireAccess>
  ),
});

type Line = { material_id: string; quantity: string };
type Sheet = {
  id: string; sheet_number: string; product_id: string; yield_quantity: number;
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

const emptyLines = (): Line[] => [{ material_id: "", quantity: "" }];

function CostingPage() {
  const qc = useQueryClient();
  const { canSubmit, canEdit, canCancel, canApprove, canReject } = usePermissions();
  const factory = useFactoryId();
  const factoryId = factory.data;
  const submitPerm = canSubmit("costing");
  const editPerm = canEdit("costing");
  const cancelPerm = canCancel("costing");
  const approvePerm = canApprove("costing");
  const rejectPerm = canReject("costing");

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [productId, setProductId] = useState("");
  const [yieldQty, setYieldQty] = useState("");
  const [labor, setLabor] = useState("0");
  const [overhead, setOverhead] = useState("0");
  const [overheadPercent, setOverheadPercent] = useState("");
  const [packQuantity, setPackQuantity] = useState("1");
  const [packCost, setPackCost] = useState("0");
  const [notes, setNotes] = useState("");
  const [applyToProduct, setApplyToProduct] = useState(true);
  const [lines, setLines] = useState<Line[]>(emptyLines());
  const [priceOptions, setPriceOptions] = useState<string[]>([""]);
  const [rejectTarget, setRejectTarget] = useState<Sheet | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const products = useQuery({
    queryKey: ["costing-products", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("products").select("id,name,unit,cost_price,unit_price").eq("factory_id", factoryId!).eq("active", true).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const materials = useQuery({
    queryKey: ["costing-materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("raw_materials").select("id,name,unit,unit_cost").eq("factory_id", factoryId!).eq("active", true).eq("approval_status", "approved").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const sheets = useQuery({
    queryKey: ["costing-sheets", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("costing_sheets")
        .select("id,sheet_number,product_id,yield_quantity,material_cost,labor_cost,overhead_cost,overhead_percent,pack_quantity,pack_cost,cost_per_pack,total_cost,unit_cost,apply_to_product,is_applied,status,created_by,notes,created_at,products(name,unit)")
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

  const materialCostPreview = lines.reduce((sum, l) => {
    const m = materials.data?.find((x) => x.id === l.material_id);
    const qty = Number(l.quantity);
    return sum + (m && qty > 0 ? m.unit_cost * qty : 0);
  }, 0);
  const overheadPreview = overheadPercent.trim() !== "" && Number(overheadPercent) >= 0
    ? materialCostPreview * (Number(overheadPercent) / 100)
    : Number(overhead) || 0;
  const totalPreview = materialCostPreview + (Number(labor) || 0) + overheadPreview;
  const unitPreview = Number(yieldQty) > 0 ? totalPreview / Number(yieldQty) : 0;
  const costPerPackPreview = unitPreview * (Number(packQuantity) || 1) + (Number(packCost) || 0);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["costing-sheets"] });
    qc.invalidateQueries({ queryKey: ["costing-products"] });
  };

  const resetForm = () => {
    setEditingId(null);
    setProductId(""); setYieldQty(""); setLabor("0"); setOverhead("0"); setOverheadPercent("");
    setPackQuantity("1"); setPackCost("0");
    setNotes(""); setApplyToProduct(true); setLines(emptyLines()); setPriceOptions([""]);
  };

  const openEdit = async (sheet: Sheet) => {
    setEditingId(sheet.id);
    setProductId(sheet.product_id);
    setYieldQty(String(sheet.yield_quantity));
    setLabor(String(sheet.labor_cost));
    setOverhead(String(sheet.overhead_cost));
    setOverheadPercent(sheet.overhead_percent != null ? String(sheet.overhead_percent) : "");
    setPackQuantity(String(sheet.pack_quantity));
    setPackCost(String(sheet.pack_cost));
    setNotes(sheet.notes ?? "");
    setApplyToProduct(sheet.apply_to_product);

    const { data: items } = await supabase.from("costing_sheet_items").select("material_id,quantity").eq("sheet_id", sheet.id);
    setLines((items ?? []).map((it) => ({ material_id: it.material_id, quantity: String(it.quantity) })) || emptyLines());

    const { data: options } = await supabase.from("costing_price_options").select("proposed_price").eq("sheet_id", sheet.id);
    setPriceOptions((options ?? []).length > 0 ? (options ?? []).map((o) => String(o.proposed_price)) : [""]);

    setOpen(true);
  };

  const buildPayload = () => ({
    factory_id: factoryId,
    product_id: productId,
    yield_quantity: Number(yieldQty),
    labor_cost: Number(labor) || 0,
    overhead_cost: Number(overhead) || 0,
    overhead_percent: overheadPercent.trim() !== "" ? Number(overheadPercent) : null,
    pack_quantity: Number(packQuantity) || 1,
    pack_cost: Number(packCost) || 0,
    apply_to_product: applyToProduct,
    notes: notes || null,
    items: lines
      .filter((l) => l.material_id && Number(l.quantity) > 0)
      .map((l) => ({ material_id: l.material_id, quantity: Number(l.quantity) })),
    price_options: priceOptions.filter((p) => p.trim() !== "" && Number(p) >= 0).map((p) => ({ proposed_price: Number(p) })),
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (editingId) {
        const { data, error } = await supabase.rpc("update_costing_sheet", { payload: { id: editingId, ...buildPayload() } });
        if (error) throw error;
        return data as { id: string; unit_cost: number; cost_per_pack: number };
      }
      const { data, error } = await supabase.rpc("submit_costing_sheet", { payload: buildPayload() });
      if (error) throw error;
      return data as { id: string; sheet_number: string; unit_cost: number; cost_per_pack: number };
    },
    onSuccess: (result: any) => {
      toast.success(editingId ? "Costing sheet updated" : `Submitted ${result.sheet_number} — awaiting approval`);
      logAudit({ action: editingId ? "update" : "create", entity: "costing_sheets", entityId: result.id, factoryId, newValue: result });
      invalidateAll();
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Costing</h1>
          <p className="text-sm text-muted-foreground">Material, labor, overhead, and packaging roll-ups per product — submitted for approval before applying to the live cost price.</p>
        </div>
        {submitPerm && (
          <Button onClick={() => { resetForm(); setOpen(true); }}>
            <Calculator className="mr-2 h-4 w-4" /> New Costing Sheet
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
                          {editPerm && isSelf && (
                            <Button variant="ghost" size="icon" title="Edit" onClick={() => openEdit(s)}>
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

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editingId ? "Edit Costing Sheet" : "New Costing Sheet"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Product</Label>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                  <SelectContent>
                    {(products.data ?? []).map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Yield quantity</Label>
                <Input type="number" min="0" step="0.001" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Material lines</Label>
                <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { material_id: "", quantity: "" }])}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add line
                </Button>
              </div>
              {lines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={line.material_id} onValueChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, material_id: v } : l)))}>
                    <SelectTrigger className="flex-1"><SelectValue placeholder="Material" /></SelectTrigger>
                    <SelectContent>
                      {(materials.data ?? []).map((m) => (<SelectItem key={m.id} value={m.id}>{m.name} ({money(m.unit_cost)}/{m.unit})</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <Input className="w-28" type="number" min="0" step="0.001" placeholder="Qty" value={line.quantity}
                    onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)))} />
                  <Button type="button" variant="ghost" size="icon" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Labor cost</Label><Input type="number" min="0" step="0.01" value={labor} onChange={(e) => setLabor(e.target.value)} /></div>
              <div className="space-y-2">
                <Label>Overhead — % of material cost (or flat below)</Label>
                <Input type="number" min="0" step="0.01" placeholder="e.g. 10" value={overheadPercent} onChange={(e) => setOverheadPercent(e.target.value)} />
              </div>
            </div>
            {overheadPercent.trim() === "" && (
              <div className="space-y-2"><Label>Overhead cost (flat)</Label><Input type="number" min="0" step="0.01" value={overhead} onChange={(e) => setOverhead(e.target.value)} /></div>
            )}

            <div className="space-y-2">
              <Label>Packaging (optional — e.g. units per carton + flat wrapper cost)</Label>
              <div className="grid grid-cols-2 gap-3">
                <Input type="number" min="1" step="1" placeholder="Units per pack" value={packQuantity} onChange={(e) => setPackQuantity(e.target.value)} />
                <Input type="number" min="0" step="0.01" placeholder="Flat pack cost" value={packCost} onChange={(e) => setPackCost(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Proposed selling prices</Label>
                <Button type="button" variant="outline" size="sm" onClick={() => setPriceOptions([...priceOptions, ""])}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add price
                </Button>
              </div>
              {priceOptions.map((p, i) => {
                const price = Number(p);
                const margin = price > 0 ? price - costPerPackPreview : null;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Input className="flex-1" type="number" min="0" step="0.01" placeholder="Proposed price" value={p}
                      onChange={(e) => setPriceOptions(priceOptions.map((x, j) => (j === i ? e.target.value : x)))} />
                    {margin !== null && (
                      <span className={`w-32 shrink-0 text-xs ${margin >= 0 ? "text-success" : "text-destructive"}`}>
                        margin {money(margin)} ({price > 0 ? ((margin / price) * 100).toFixed(1) : "0"}%)
                      </span>
                    )}
                    <Button type="button" variant="ghost" size="icon" onClick={() => setPriceOptions(priceOptions.filter((_, j) => j !== i))} disabled={priceOptions.length === 1}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

            <div className="flex items-center gap-2">
              <Checkbox id="apply" checked={applyToProduct} onCheckedChange={(v) => setApplyToProduct(!!v)} />
              <Label htmlFor="apply" className="cursor-pointer">Apply computed cost per pack to this product's cost price once approved</Label>
            </div>

            <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Material cost</span><span>{money(materialCostPreview)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Overhead</span><span>{money(overheadPreview)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Total cost</span><span className="font-medium">{money(totalPreview)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Unit cost</span><span>{money(unitPreview)}</span></div>
              <div className="flex justify-between border-t pt-1 mt-1"><span className="text-muted-foreground">Cost per pack (applied)</span><span className="font-semibold">{money(costPerPackPreview)}</span></div>
            </div>
            <p className="text-xs text-muted-foreground">Requires a second person's approval — this submits a request instead of changing the product's cost price immediately.</p>
          </div>
          <DialogFooter>
            <Button
              disabled={submit.isPending || !productId || !yieldQty || lines.every((l) => !l.material_id)}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? "Saving…" : editingId ? "Save changes" : "Submit for approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
