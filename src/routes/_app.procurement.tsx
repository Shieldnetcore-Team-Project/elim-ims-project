import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  Printer,
  Check,
  X,
  Eye,
  ClipboardList,
  Loader2,
  FileStack,
  Ban,
  PackagePlus,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { num, money } from "@/lib/format";
import { toast } from "sonner";
import { generateProductionRequestPdf, generatePurchaseOrderPdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import { usePendingAttention } from "@/lib/pending-attention";
import { QuickAddMaterialDialog, ADD_NEW_ITEM } from "@/components/shared/quick-add-item";

export const Route = createFileRoute("/_app/procurement")({
  head: () => ({
    meta: [{ title: "Procurement — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: ProcurementPage,
});

type Material = { id: string; name: string; unit: string; current_stock: number };
type Supplier = { id: string; name: string };

type RequestRow = {
  id: string;
  request_number: string;
  requested_by_name: string;
  department: string | null;
  material_id: string | null;
  supplier_id: string | null;
  po_number: string | null;
  quantity_requested: number;
  unit: string | null;
  request_date: string;
  approval_status: string;
  approved_by_name: string | null;
  approval_date: string | null;
  auto_generated: boolean;
  remarks: string | null;
  raw_materials: { name: string; unit: string } | null;
  suppliers: { name: string } | null;
};

type ApprovedRequest = {
  id: string;
  request_number: string;
  quantity_requested: number;
  unit: string | null;
  supplier_id: string | null;
  material_id: string;
  raw_materials: { name: string; unit: string } | null;
  suppliers: { name: string } | null;
};

type PoRow = {
  id: string;
  po_number: string;
  purchase_request_id: string;
  supplier_id: string | null;
  material_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit: string | null;
  unit_cost: number | null;
  expected_delivery_date: string | null;
  status: string;
  notes: string | null;
  issued_by_name: string;
  issued_at: string;
  cancel_reason: string | null;
  approved_by_name: string | null;
  total_amount: number | null;
  raw_materials: { name: string; unit: string } | null;
  suppliers: { name: string; phone: string | null; address: string | null } | null;
  production_requests: { request_number: string } | null;
};

const approvalBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "approved" ? "secondary" : s === "rejected" ? "destructive" : "outline";

const poStatusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "received") return "secondary";
  if (s === "cancelled") return "destructive";
  if (s === "partially_received") return "default";
  return "outline";
};

function ProcurementPage() {
  const { data: factoryId } = useFactoryId();
  const { canView, canSubmit, canApprove, canReject, canCreate, canCancel } = usePermissions();
  const viewRequests = canView("production-requests");
  const viewOrders = canView("purchase-orders");
  const pendingPurchaseRequests =
    usePendingAttention().items.find((i) => i.key === "purchase-requests")?.count ?? 0;

  if (!viewRequests && !viewOrders) {
    return (
      <div className="space-y-4">
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" /> Access restricted
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Your role doesn't have access to Procurement. Contact an Admin or Factory Manager if you
            believe this is a mistake.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Procurement</h1>
        <p className="text-sm text-muted-foreground">
          Every purchase request lands here, gets approved, and turns into a purchase order — Goods
          Receiving matches deliveries against those orders. Requests can also appear automatically
          when a material's stock drops to its reorder level.
        </p>
      </div>

      {viewRequests && viewOrders ? (
        <Tabs defaultValue="requests" className="space-y-4">
          <TabsList>
            <TabsTrigger value="requests" className="gap-2">
              Purchase Requests
              {pendingPurchaseRequests > 0 && (
                <Badge
                  variant="destructive"
                  className="h-5 min-w-5 justify-center rounded-full px-1"
                >
                  {pendingPurchaseRequests}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="orders">Purchase Orders</TabsTrigger>
          </TabsList>
          <TabsContent value="requests">
            <RequestsSection
              factoryId={factoryId}
              submitPerm={canSubmit("production-requests")}
              approvePerm={canApprove("production-requests")}
              rejectPerm={canReject("production-requests")}
            />
          </TabsContent>
          <TabsContent value="orders">
            <OrdersSection
              factoryId={factoryId}
              createPerm={canCreate("purchase-orders")}
              cancelPerm={canCancel("purchase-orders")}
              receivePerm={canSubmit("goods-receiving")}
            />
          </TabsContent>
        </Tabs>
      ) : viewRequests ? (
        <RequestsSection
          factoryId={factoryId}
          submitPerm={canSubmit("production-requests")}
          approvePerm={canApprove("production-requests")}
          rejectPerm={canReject("production-requests")}
        />
      ) : (
        <OrdersSection
          factoryId={factoryId}
          createPerm={canCreate("purchase-orders")}
          cancelPerm={canCancel("purchase-orders")}
          receivePerm={canSubmit("goods-receiving")}
        />
      )}
    </div>
  );
}

// ============================== Requests ==============================

function RequestsSection({
  factoryId,
  submitPerm,
  approvePerm,
  rejectPerm,
}: {
  factoryId: string | undefined;
  submitPerm: boolean;
  approvePerm: boolean;
  rejectPerm: boolean;
}) {
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<RequestRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<RequestRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<RequestRow | null>(null);

  const materials = useQuery({
    queryKey: ["raw-materials-brief", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,current_stock")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .eq("approval_status", "approved")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Material[];
    },
  });

  const suppliers = useQuery({
    queryKey: ["suppliers-brief", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Supplier[];
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const list = useQuery({
    queryKey: ["purchase-requests-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_requests")
        .select(
          "id,request_number,requested_by_name,department,material_id,supplier_id,po_number,quantity_requested,unit,request_date,approval_status,approved_by_name,approval_date,auto_generated,remarks,raw_materials(name,unit),suppliers(name)",
        )
        .eq("factory_id", factoryId!)
        .eq("request_type", "purchase")
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as RequestRow[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["purchase-requests-list"] });
    qc.invalidateQueries({ queryKey: ["approved-purchase-requests-without-po"] });
  };

  const printRequest = (row: RequestRow) => {
    generateProductionRequestPdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          logo_url: settings.data?.logo_url,
        },
        request_number: row.request_number,
        request_date: new Date(row.request_date).toLocaleString(),
        requested_by_name: row.requested_by_name,
        department: row.department,
        product_name: row.raw_materials?.name ?? "—",
        quantity_requested: Number(row.quantity_requested),
        unit: row.unit ?? row.raw_materials?.unit ?? "",
        approval_status: row.approval_status,
        approved_by_name: row.approved_by_name,
        approval_date: row.approval_date,
        materials_issued: false,
        issued_by_name: null,
        issued_at: null,
        production_status: row.po_number ? "completed" : row.approval_status,
        materials: [],
        remarks: row.remarks,
      },
      "print",
    );
    logAudit({ action: "print", entity: "production_requests", entityId: row.id, factoryId });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {submitPerm && (
          <Dialog open={formOpen} onOpenChange={setFormOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" /> New Purchase Request
              </Button>
            </DialogTrigger>
            {formOpen && factoryId && (
              <RequestForm
                factoryId={factoryId}
                materials={materials.data ?? []}
                suppliers={suppliers.data ?? []}
                onDone={() => {
                  setFormOpen(false);
                  invalidateAll();
                }}
              />
            )}
          </Dialog>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Requests</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Requested By</TableHead>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.request_number}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(row.request_date).toLocaleString()}
                  </TableCell>
                  <TableCell>{row.requested_by_name}</TableCell>
                  <TableCell className="font-medium">
                    {row.raw_materials?.name ?? "—"}
                    {row.auto_generated && (
                      <Badge variant="outline" className="ml-2 gap-1">
                        <Sparkles className="h-3 w-3" /> Auto (low stock)
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(Number(row.quantity_requested))} {row.unit}
                  </TableCell>
                  <TableCell>{row.suppliers?.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={approvalBadge(row.approval_status)} className="capitalize">
                      {row.approval_status}
                    </Badge>
                    {row.po_number && (
                      <Badge variant="secondary" className="ml-2">
                        PO issued
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {row.approval_status === "pending" && approvePerm && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Approve"
                          onClick={() => setApproveTarget(row)}
                        >
                          <Check className="h-4 w-4 text-success" />
                        </Button>
                      )}
                      {row.approval_status === "pending" && rejectPerm && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Reject"
                          onClick={() => setRejectTarget(row)}
                        >
                          <X className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="View"
                        onClick={() => setDetailTarget(row)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Print"
                        onClick={() => printRequest(row)}
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No purchase requests yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && (
          <ApproveDialog
            row={approveTarget}
            currentUserId={currentUser.data ?? null}
            onDone={() => {
              setApproveTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && (
          <RejectDialog
            row={rejectTarget}
            onDone={() => {
              setRejectTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!detailTarget} onOpenChange={(v) => !v && setDetailTarget(null)}>
        {detailTarget && <RequestDetailDialog row={detailTarget} />}
      </Dialog>
    </div>
  );
}

function RequestForm({
  factoryId,
  materials,
  suppliers,
  onDone,
}: {
  factoryId: string;
  materials: Material[];
  suppliers: Supplier[];
  onDone: () => void;
}) {
  const [requestedBy, setRequestedBy] = useState("");
  // Row index that asked for "+ Add new material…" (null = dialog closed).
  const [addingMaterialFor, setAddingMaterialFor] = useState<number | null>(null);
  const [department, setDepartment] = useState("");
  const [remarks, setRemarks] = useState("");
  const [items, setItems] = useState<
    { materialId: string; quantity: number; supplierId: string }[]
  >([{ materialId: "", quantity: 0, supplierId: "none" }]);

  const updateItem = (
    i: number,
    patch: Partial<{ materialId: string; quantity: number; supplierId: string }>,
  ) => {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  };
  const addItem = () =>
    setItems((prev) => [...prev, { materialId: "", quantity: 0, supplierId: "none" }]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const save = useMutation({
    mutationFn: async () => {
      if (!requestedBy.trim()) throw new Error("Enter the requesting staff name");
      const validItems = items.filter((it) => it.materialId && it.quantity > 0);
      if (validItems.length === 0) throw new Error("Add at least one material with a quantity");

      const results: { id: string; request_number: string }[] = [];
      for (const it of validItems) {
        const m = materials.find((mm) => mm.id === it.materialId);
        const { data, error } = await supabase.rpc("create_production_request", {
          payload: {
            factory_id: factoryId,
            requested_by_name: requestedBy.trim(),
            department: department || null,
            request_type: "purchase",
            material_id: it.materialId,
            quantity_requested: it.quantity,
            unit: m?.unit,
            supplier_id: it.supplierId === "none" ? null : it.supplierId,
            remarks: remarks || null,
          } as any,
        });
        if (error) throw error;
        results.push(data as any);
      }
      return results;
    },
    onSuccess: (results) => {
      toast.success(
        results.length === 1
          ? `Request ${results[0]?.request_number ?? ""} created`
          : `${results.length} purchase requests created`,
      );
      results.forEach((r) =>
        logAudit({ action: "create", entity: "production_requests", entityId: r.id }),
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>New Purchase Request</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Requesting staff</Label>
            <Input
              value={requestedBy}
              onChange={(e) => setRequestedBy(e.target.value)}
              placeholder="Full name"
            />
          </div>
          <div>
            <Label>Department</Label>
            <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Label>Materials to purchase</Label>
          <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addItem}>
            <Plus className="h-3.5 w-3.5" /> Add item
          </Button>
        </div>
        <div className="grid gap-2">
          {items.map((it, i) => (
            <div key={i} className="grid grid-cols-[2fr_1fr_1.4fr_auto] items-center gap-2">
              <Select
                value={it.materialId}
                onValueChange={(v) =>
                  v === ADD_NEW_ITEM ? setAddingMaterialFor(i) : updateItem(i, { materialId: v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select material…" />
                </SelectTrigger>
                <SelectContent>
                  {materials.map((mat) => (
                    <SelectItem key={mat.id} value={mat.id}>
                      {mat.name} · stock {num(Number(mat.current_stock))} {mat.unit}
                    </SelectItem>
                  ))}
                  <SelectItem value={ADD_NEW_ITEM} className="font-medium text-primary">
                    + Add new material…
                  </SelectItem>
                </SelectContent>
              </Select>
              <MoneyInput
                min={0.001}
                step="0.001"
                placeholder="Qty"
                value={it.quantity}
                onChange={(v) => updateItem(i, { quantity: v })}
              />
              <Select value={it.supplierId} onValueChange={(v) => updateItem(i, { supplierId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Supplier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeItem(i)}
                disabled={items.length === 1}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
        <QuickAddMaterialDialog
          open={addingMaterialFor !== null}
          onOpenChange={(v) => !v && setAddingMaterialFor(null)}
          factoryId={factoryId}
          onCreated={(id) => {
            if (addingMaterialFor !== null) updateItem(addingMaterialFor, { materialId: id });
          }}
        />

        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()} className="gap-2">
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ClipboardList className="h-4 w-4" />
          )}
          {save.isPending ? "Saving…" : "Submit Request"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ApproveDialog({
  row,
  currentUserId,
  onDone,
}: {
  row: RequestRow;
  currentUserId: string | null;
  onDone: () => void;
}) {
  const [name, setName] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Enter the approver's name");
      const { error } = await supabase.rpc("approve_production_request", {
        p_id: row.id,
        p_approver_name: name.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Request approved");
      logAudit({
        action: "update",
        entity: "production_requests",
        entityId: row.id,
        newValue: { approval_status: "approved", approved_by_name: name },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Approve — {row.request_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {row.raw_materials?.name} · {num(Number(row.quantity_requested))} {row.unit} · requested
          by {row.requested_by_name}
        </p>
        <div>
          <Label>Approver name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || !name.trim()} onClick={() => submit.mutate()}>
          {submit.isPending ? "Approving…" : "Approve Request"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectDialog({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Enter the approver's name");
      const { error } = await supabase.rpc("reject_production_request", {
        p_id: row.id,
        p_approver_name: name.trim(),
        p_reason: reason || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Request rejected");
      logAudit({
        action: "update",
        entity: "production_requests",
        entityId: row.id,
        newValue: { approval_status: "rejected", approved_by_name: name, reason },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject — {row.request_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Approver name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={submit.isPending || !name.trim()}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Rejecting…" : "Reject Request"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RequestDetailDialog({ row }: { row: RequestRow }) {
  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{row.request_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="text-muted-foreground">Requested by:</span> {row.requested_by_name}
          </div>
          <div>
            <span className="text-muted-foreground">Department:</span> {row.department ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Material:</span>{" "}
            {row.raw_materials?.name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Quantity:</span>{" "}
            {num(Number(row.quantity_requested))} {row.unit}
          </div>
          <div>
            <span className="text-muted-foreground">Supplier:</span> {row.suppliers?.name ?? "—"}
          </div>
          {row.po_number && (
            <div>
              <span className="text-muted-foreground">PO #:</span> {row.po_number}
            </div>
          )}
          <div>
            <span className="text-muted-foreground">Requested:</span>{" "}
            {new Date(row.request_date).toLocaleString()}
          </div>
          <div>
            <span className="text-muted-foreground">Approval:</span>{" "}
            <Badge variant={approvalBadge(row.approval_status)} className="capitalize">
              {row.approval_status}
            </Badge>
          </div>
          <div>
            <span className="text-muted-foreground">Approved by:</span>{" "}
            {row.approved_by_name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Source:</span>{" "}
            {row.auto_generated ? "Auto-generated (low stock)" : "Manual"}
          </div>
        </div>
        {row.remarks && (
          <div>
            <span className="text-muted-foreground">Remarks:</span> {row.remarks}
          </div>
        )}
      </div>
    </DialogContent>
  );
}

// ============================== Orders ==============================

function OrdersSection({
  factoryId,
  createPerm,
  cancelPerm,
  receivePerm,
}: {
  factoryId: string | undefined;
  createPerm: boolean;
  cancelPerm: boolean;
  receivePerm: boolean;
}) {
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
        .select(
          "id,request_number,quantity_requested,unit,supplier_id,material_id,raw_materials(name,unit),suppliers(name)",
        )
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
        .select(
          "id,po_number,purchase_request_id,supplier_id,material_id,quantity_ordered,quantity_received,unit,unit_cost,expected_delivery_date,status,notes,issued_by_name,issued_at,cancel_reason,approved_by_name,total_amount,raw_materials(name,unit),suppliers(name,phone,address),production_requests(request_number)",
        )
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
    qc.invalidateQueries({ queryKey: ["purchase-requests-list"] });
  };

  const printPo = (row: PoRow) => {
    generatePurchaseOrderPdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          logo_url: settings.data?.logo_url,
        },
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
    <div className="space-y-4">
      <div className="flex justify-end">
        {createPerm && (
          <Button className="gap-2" onClick={() => setCreateOpen(true)}>
            <FileStack className="h-4 w-4" /> Issue Purchase Order
          </Button>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Orders</CardTitle>
        </CardHeader>
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
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(row.issued_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-medium">{row.raw_materials?.name ?? "—"}</TableCell>
                  <TableCell>{row.suppliers?.name ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {num(Number(row.quantity_ordered))} {row.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(Number(row.quantity_received))} {row.unit}
                  </TableCell>
                  <TableCell>
                    <Badge variant={poStatusBadge(row.status)} className="capitalize">
                      {row.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {receivePerm &&
                        (row.status === "issued" || row.status === "partially_received") && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Receive goods"
                            onClick={() => setReceiveTarget(row)}
                          >
                            <PackagePlus className="h-4 w-4 text-success" />
                          </Button>
                        )}
                      {cancelPerm &&
                        (row.status === "issued" || row.status === "partially_received") && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Cancel"
                            onClick={() => setCancelTarget(row)}
                          >
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="View"
                        onClick={() => setDetailTarget(row)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Print"
                        onClick={() => printPo(row)}
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No purchase orders yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {createOpen && (
          <CreatePoDialog
            candidates={approvedRequests.data ?? []}
            onDone={() => {
              setCreateOpen(false);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!receiveTarget} onOpenChange={(v) => !v && setReceiveTarget(null)}>
        {receiveTarget && (
          <ReceiveDialog
            row={receiveTarget}
            onDone={() => {
              setReceiveTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && (
          <CancelDialog
            row={cancelTarget}
            onDone={() => {
              setCancelTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!detailTarget} onOpenChange={(v) => !v && setDetailTarget(null)}>
        {detailTarget && <OrderDetailDialog row={detailTarget} />}
      </Dialog>
    </div>
  );
}

function CreatePoDialog({
  candidates,
  onDone,
}: {
  candidates: ApprovedRequest[];
  onDone: () => void;
}) {
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
          purchase_request_id: requestId,
          issued_by_name: issuedByName.trim(),
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
      <DialogHeader>
        <DialogTitle>Issue Purchase Order</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No approved purchase requests are awaiting a purchase order right now.
          </p>
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
                <SelectTrigger>
                  <SelectValue placeholder="Select request…" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.request_number} · {r.raw_materials?.name} ·{" "}
                      {num(Number(r.quantity_requested))} {r.unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selected && (
              <p className="text-xs text-muted-foreground">
                Material: {selected.raw_materials?.name} · Requested supplier:{" "}
                {selected.suppliers?.name ?? "—"}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Quantity to order</Label>
                <MoneyInput
                  min={0.001}
                  step="0.001"
                  value={quantity === "" ? 0 : quantity}
                  onChange={(v) => setQuantity(v === 0 ? "" : v)}
                />
              </div>
              <div>
                <Label>Unit cost</Label>
                <MoneyInput value={unitCost === "" ? 0 : unitCost} onChange={setUnitCost} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Expected delivery date</Label>
                <Input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                />
              </div>
              <div>
                <Label>Issued by</Label>
                <Input
                  value={issuedByName}
                  onChange={(e) => setIssuedByName(e.target.value)}
                  placeholder="Your name"
                />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </>
        )}
      </div>
      {candidates.length > 0 && (
        <DialogFooter>
          <Button
            disabled={submit.isPending || !requestId || !issuedByName.trim()}
            onClick={() => submit.mutate()}
            className="gap-2"
          >
            {submit.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileStack className="h-4 w-4" />
            )}
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
  const [unitCost, setUnitCost] = useState<number | "">(
    row.unit_cost != null ? Number(row.unit_cost) : "",
  );
  const [deliveryReference, setDeliveryReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const accepted = Math.max(quantity - damagedQuantity, 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      if (quantity > outstanding)
        throw new Error(
          `Cannot exceed the ${num(outstanding)} ${row.unit ?? ""} still outstanding`,
        );
      if (damagedQuantity < 0 || damagedQuantity > quantity)
        throw new Error("Damaged quantity must be between 0 and the received quantity");
      const { error } = await supabase.rpc("submit_goods_receipt", {
        payload: {
          purchase_order_id: row.id,
          quantity,
          damaged_quantity: damagedQuantity,
          unit_cost: unitCost === "" ? undefined : unitCost,
          delivery_reference: deliveryReference || undefined,
          remarks: remarks || undefined,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Submitted — awaiting confirmation by a different person");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Receive Goods — {row.po_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          {row.raw_materials?.name} · {num(outstanding)} {row.unit} outstanding of{" "}
          {num(Number(row.quantity_ordered))} {row.unit} ordered. Dual control: this only posts to
          stock once someone else confirms it.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Quantity received</Label>
            <MoneyInput
              min={0.001}
              max={outstanding}
              step="0.001"
              value={quantity}
              onChange={setQuantity}
            />
          </div>
          <div>
            <Label>Damaged quantity</Label>
            <MoneyInput
              min={0}
              max={quantity}
              step="0.001"
              value={damagedQuantity}
              onChange={setDamagedQuantity}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Accepted quantity: {num(accepted)} {row.unit} — only this posts to stock; damaged goes to
          the damage ledger.
        </p>
        <div>
          <Label>Unit cost</Label>
          <MoneyInput value={unitCost === "" ? 0 : unitCost} onChange={setUnitCost} />
        </div>
        <div>
          <Label>Delivery reference</Label>
          <Input
            value={deliveryReference}
            onChange={(e) => setDeliveryReference(e.target.value)}
            placeholder="Waybill / delivery note number"
          />
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || quantity <= 0 || damagedQuantity > quantity}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Submitting…" : "Submit for Confirmation"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelDialog({ row, onDone }: { row: PoRow; onDone: () => void }) {
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_purchase_order", {
        p_id: row.id,
        p_reason: reason || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Purchase order cancelled");
      logAudit({
        action: "update",
        entity: "purchase_orders",
        entityId: row.id,
        newValue: { status: "cancelled", reason },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel — {row.po_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {row.raw_materials?.name} · {num(Number(row.quantity_ordered))} {row.unit}
        </p>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Cancelling…" : "Cancel Purchase Order"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function OrderDetailDialog({ row }: { row: PoRow }) {
  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{row.po_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="text-muted-foreground">Material:</span>{" "}
            {row.raw_materials?.name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Supplier:</span> {row.suppliers?.name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Ordered:</span>{" "}
            {num(Number(row.quantity_ordered))} {row.unit}
          </div>
          <div>
            <span className="text-muted-foreground">Received:</span>{" "}
            {num(Number(row.quantity_received))} {row.unit}
          </div>
          <div>
            <span className="text-muted-foreground">Unit cost:</span>{" "}
            {row.unit_cost != null ? num(Number(row.unit_cost)) : "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Total:</span>{" "}
            {row.total_amount != null ? money(Number(row.total_amount)) : "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Status:</span>{" "}
            <Badge variant={poStatusBadge(row.status)} className="capitalize">
              {row.status.replace(/_/g, " ")}
            </Badge>
          </div>
          <div>
            <span className="text-muted-foreground">Expected delivery:</span>{" "}
            {row.expected_delivery_date ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Created by:</span> {row.issued_by_name}
          </div>
          <div>
            <span className="text-muted-foreground">Approved by:</span>{" "}
            {row.approved_by_name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Issued:</span>{" "}
            {new Date(row.issued_at).toLocaleString()}
          </div>
          <div>
            <span className="text-muted-foreground">From request:</span>{" "}
            {row.production_requests?.request_number ?? "—"}
          </div>
        </div>
        {row.notes && (
          <div>
            <span className="text-muted-foreground">Notes:</span> {row.notes}
          </div>
        )}
        {row.cancel_reason && (
          <div>
            <span className="text-muted-foreground">Cancel reason:</span> {row.cancel_reason}
          </div>
        )}
      </div>
    </DialogContent>
  );
}
