import { createFileRoute, Link } from "@tanstack/react-router";
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
import {
  Plus,
  Trash2,
  Printer,
  Check,
  X,
  PackageMinus,
  Eye,
  ClipboardList,
  Loader2,
  FileStack,
} from "lucide-react";
import { num } from "@/lib/format";
import { toast } from "sonner";
import { generateProductionRequestPdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";

export const Route = createFileRoute("/_app/production-requests")({
  head: () => ({
    meta: [{ title: "Production Requests — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="production-requests">
      <ProductionRequestsPage />
    </RequireAccess>
  ),
});

type Product = { id: string; name: string; unit: string; current_stock: number };
type Material = { id: string; name: string; unit: string; current_stock: number };
type Supplier = { id: string; name: string };
type RequestRow = {
  id: string;
  request_number: string;
  requested_by: string | null;
  requested_by_name: string;
  department: string | null;
  request_type: string;
  product_id: string | null;
  material_id: string | null;
  supplier_id: string | null;
  po_number: string | null;
  quantity_requested: number;
  unit: string | null;
  request_date: string;
  approval_status: string;
  approved_by_name: string | null;
  approval_date: string | null;
  materials_issued: boolean;
  issued_by_name: string | null;
  issued_at: string | null;
  production_status: string;
  remarks: string | null;
  products: { name: string; unit: string } | null;
  raw_materials: { name: string; unit: string } | null;
  suppliers: { name: string } | null;
  production: { production_number: string } | null;
};
type RequestItem = {
  id: string;
  material_id: string;
  quantity_requested: number;
  quantity_issued: number;
  unit: string | null;
  raw_materials: { name: string; unit: string; current_stock: number } | null;
};

const approvalBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "approved" ? "secondary" : s === "rejected" ? "destructive" : "outline";

const productionStatusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "completed") return "secondary";
  if (s === "rejected" || s === "cancelled") return "destructive";
  if (s === "materials_issued") return "default";
  return "outline";
};

function ProductionRequestsPage() {
  const { data: factoryId } = useFactoryId();
  const { canSubmit, canApprove, canReject, canCreate } = usePermissions();
  const submit = canSubmit("production-requests");
  const approvePerm = canApprove("production-requests");
  const rejectPerm = canReject("production-requests");
  const createPoPerm = canCreate("purchase-orders");
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<RequestRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<RequestRow | null>(null);
  const [issueTarget, setIssueTarget] = useState<RequestRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<RequestRow | null>(null);

  const products = useQuery({
    queryKey: ["products-for-production", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,current_stock")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });

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
    queryKey: ["production-requests-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_requests")
        .select(
          "id,request_number,requested_by,requested_by_name,department,request_type,product_id,material_id,supplier_id,po_number,quantity_requested,unit,request_date,approval_status,approved_by_name,approval_date,materials_issued,issued_by_name,issued_at,production_status,remarks,products(name,unit),raw_materials(name,unit),suppliers(name),production:production!production_requests_production_id_fkey(production_number)",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as RequestRow[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["production-requests-list"] });
    qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
    qc.invalidateQueries({ queryKey: ["raw-materials-brief"] });
    qc.invalidateQueries({ queryKey: ["material-movements"] });
    qc.invalidateQueries({ queryKey: ["inv-movements"] });
  };

  const fetchItems = async (requestId: string) => {
    const { data, error } = await supabase
      .from("production_request_items")
      .select(
        "id,material_id,quantity_requested,quantity_issued,unit,raw_materials(name,unit,current_stock)",
      )
      .eq("request_id", requestId);
    if (error) throw error;
    return (data ?? []) as unknown as RequestItem[];
  };

  const printRequest = async (row: RequestRow) => {
    const items = await fetchItems(row.id);
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
        product_name:
          row.request_type === "purchase"
            ? (row.raw_materials?.name ?? "—")
            : (row.products?.name ?? "—"),
        quantity_requested: Number(row.quantity_requested),
        unit: row.unit ?? row.products?.unit ?? "",
        approval_status: row.approval_status,
        approved_by_name: row.approved_by_name,
        approval_date: row.approval_date,
        materials_issued: row.materials_issued,
        issued_by_name: row.issued_by_name,
        issued_at: row.issued_at,
        production_status: row.production_status,
        materials: items.map((it) => ({
          name: it.raw_materials?.name ?? "—",
          quantity_requested: Number(it.quantity_requested),
          unit: it.unit ?? it.raw_materials?.unit ?? "",
          quantity_issued: Number(it.quantity_issued),
        })),
        remarks: row.remarks,
      },
      "print",
    );
    logAudit({ action: "print", entity: "production_requests", entityId: row.id, factoryId });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Production Requests</h1>
          <p className="text-sm text-muted-foreground">
            Request, approve, and issue raw materials for a production run — the link between
            Inventory and Production.
          </p>
        </div>
        {submit && (
          <Dialog open={formOpen} onOpenChange={setFormOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" /> New Request
              </Button>
            </DialogTrigger>
            {formOpen && factoryId && (
              <RequestForm
                factoryId={factoryId}
                products={products.data ?? []}
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
                <TableHead>Department</TableHead>
                <TableHead>Product / Material</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Status</TableHead>
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
                  <TableCell>{row.department ?? "—"}</TableCell>
                  <TableCell className="font-medium">
                    {row.request_type === "purchase"
                      ? (row.raw_materials?.name ?? "—")
                      : (row.products?.name ?? "—")}
                    {row.request_type === "purchase" && (
                      <Badge variant="outline" className="ml-2">
                        Purchase
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(Number(row.quantity_requested))} {row.unit}
                  </TableCell>
                  <TableCell>
                    <Badge variant={approvalBadge(row.approval_status)} className="capitalize">
                      {row.approval_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={productionStatusBadge(row.production_status)}
                      className="capitalize"
                    >
                      {row.production_status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {row.approval_status === "pending" &&
                        approvePerm &&
                        row.requested_by !== currentUser.data && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve"
                            onClick={() => setApproveTarget(row)}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                        )}
                      {row.approval_status === "pending" &&
                        rejectPerm &&
                        row.requested_by !== currentUser.data && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reject"
                            onClick={() => setRejectTarget(row)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      {row.request_type === "production_material" &&
                        row.approval_status === "approved" &&
                        !row.materials_issued && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Issue materials"
                            onClick={() => setIssueTarget(row)}
                          >
                            <PackageMinus className="h-4 w-4 text-warning" />
                          </Button>
                        )}
                      {row.request_type === "purchase" &&
                        row.approval_status === "approved" &&
                        !row.po_number &&
                        createPoPerm && (
                          <Button variant="ghost" size="icon" title="Issue purchase order" asChild>
                            <Link to="/purchase-orders">
                              <FileStack className="h-4 w-4 text-warning" />
                            </Link>
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
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No production requests yet.
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
      <Dialog open={!!issueTarget} onOpenChange={(v) => !v && setIssueTarget(null)}>
        {issueTarget && (
          <IssueDialog
            row={issueTarget}
            fetchItems={fetchItems}
            onDone={() => {
              setIssueTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!detailTarget} onOpenChange={(v) => !v && setDetailTarget(null)}>
        {detailTarget && <DetailDialog row={detailTarget} fetchItems={fetchItems} />}
      </Dialog>
    </div>
  );
}

function RequestForm({
  factoryId,
  products,
  materials,
  suppliers,
  onDone,
}: {
  factoryId: string;
  products: Product[];
  materials: Material[];
  suppliers: Supplier[];
  onDone: () => void;
}) {
  const [requestType, setRequestType] = useState<"production_material" | "purchase">(
    "production_material",
  );
  const [requestedBy, setRequestedBy] = useState("");
  const [department, setDepartment] = useState("");
  const [productId, setProductId] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [supplierId, setSupplierId] = useState("none");
  const [quantity, setQuantity] = useState(0);
  const [unit, setUnit] = useState("");
  const [remarks, setRemarks] = useState("");
  const [items, setItems] = useState<{ materialId: string; quantity: number }[]>([
    { materialId: "", quantity: 0 },
  ]);

  const selectedProduct = products.find((p) => p.id === productId);
  const selectedMaterial = materials.find((m) => m.id === materialId);

  const updateItem = (i: number, patch: Partial<{ materialId: string; quantity: number }>) => {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  };
  const addItem = () => setItems((prev) => [...prev, { materialId: "", quantity: 0 }]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const save = useMutation({
    mutationFn: async () => {
      if (!requestedBy.trim()) throw new Error("Enter the requesting staff name");
      if (quantity <= 0) throw new Error("Quantity requested must be > 0");

      if (requestType === "purchase") {
        if (!materialId) throw new Error("Select the material to purchase");
        const { data, error } = await supabase.rpc("create_production_request", {
          payload: {
            factory_id: factoryId,
            requested_by_name: requestedBy.trim(),
            department: department || null,
            request_type: "purchase",
            material_id: materialId,
            quantity_requested: quantity,
            unit: unit || selectedMaterial?.unit,
            supplier_id: supplierId === "none" ? null : supplierId,
            remarks: remarks || null,
          } as any,
        });
        if (error) throw error;
        return data as any;
      }

      if (!productId) throw new Error("Select the product to be produced");
      const validItems = items.filter((it) => it.materialId && it.quantity > 0);
      if (validItems.length === 0) throw new Error("Add at least one raw material with a quantity");

      const { data, error } = await supabase.rpc("create_production_request", {
        payload: {
          factory_id: factoryId,
          requested_by_name: requestedBy.trim(),
          department: department || null,
          request_type: "production_material",
          product_id: productId,
          quantity_requested: quantity,
          unit: unit || selectedProduct?.unit,
          remarks: remarks || null,
          items: validItems.map((it) => {
            const m = materials.find((mm) => mm.id === it.materialId);
            return { material_id: it.materialId, quantity: it.quantity, unit: m?.unit };
          }),
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (data) => {
      toast.success(`Request ${data?.request_number ?? ""} created`);
      logAudit({
        action: "create",
        entity: "production_requests",
        entityId: data?.id,
        factoryId,
        newValue: { request_type: requestType, quantity_requested: quantity },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>New Request</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        <div>
          <Label>Request type</Label>
          <Select
            value={requestType}
            onValueChange={(v) => setRequestType(v as typeof requestType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="production_material">Production materials (internal)</SelectItem>
              <SelectItem value="purchase">Purchase from supplier</SelectItem>
            </SelectContent>
          </Select>
        </div>
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

        {requestType === "purchase" ? (
          <>
            <div>
              <Label>Material to purchase</Label>
              <Select
                value={materialId}
                onValueChange={(v) => {
                  setMaterialId(v);
                  const m = materials.find((x) => x.id === v);
                  if (m) setUnit(m.unit);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select material…" />
                </SelectTrigger>
                <SelectContent>
                  {materials.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name} · stock {num(Number(m.current_stock))} {m.unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Quantity requested</Label>
                <Input
                  type="number"
                  min={0.001}
                  step="0.001"
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Unit</Label>
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Supplier</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger>
                  <SelectValue />
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
            </div>
          </>
        ) : (
          <>
            <div>
              <Label>Product to be produced</Label>
              <Select
                value={productId}
                onValueChange={(v) => {
                  setProductId(v);
                  const p = products.find((x) => x.id === v);
                  if (p) setUnit(p.unit);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product…" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · stock {num(Number(p.current_stock))} {p.unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Quantity requested</Label>
                <Input
                  type="number"
                  min={0.001}
                  step="0.001"
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Unit</Label>
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label>Raw materials required</Label>
              <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addItem}>
                <Plus className="h-3.5 w-3.5" /> Add material
              </Button>
            </div>
            <div className="grid gap-2">
              {items.map((it, i) => {
                const m = materials.find((mm) => mm.id === it.materialId);
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                      value={it.materialId}
                      onValueChange={(v) => updateItem(i, { materialId: v })}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select material…" />
                      </SelectTrigger>
                      <SelectContent>
                        {materials.map((mat) => (
                          <SelectItem key={mat.id} value={mat.id}>
                            {mat.name} · stock {num(Number(mat.current_stock))} {mat.unit}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0.001}
                      step="0.001"
                      className="w-28"
                      placeholder="Qty"
                      value={it.quantity}
                      onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })}
                    />
                    <span className="w-12 shrink-0 text-xs text-muted-foreground">
                      {m?.unit ?? ""}
                    </span>
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
                );
              })}
            </div>
          </>
        )}

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

function ApproveDialog({ row, onDone }: { row: RequestRow; onDone: () => void }) {
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
          {row.request_type === "purchase" ? row.raw_materials?.name : row.products?.name} ·{" "}
          {num(Number(row.quantity_requested))} {row.unit} · requested by {row.requested_by_name}
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

function IssueDialog({
  row,
  fetchItems,
  onDone,
}: {
  row: RequestRow;
  fetchItems: (id: string) => Promise<RequestItem[]>;
  onDone: () => void;
}) {
  const [name, setName] = useState("");

  const items = useQuery({
    queryKey: ["production-request-items", row.id],
    queryFn: () => fetchItems(row.id),
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Enter the issuer's name");
      const { error } = await supabase.rpc("issue_production_request_materials", {
        payload: { request_id: row.id, issued_by_name: name.trim() } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Materials issued to production");
      logAudit({
        action: "update",
        entity: "production_requests",
        entityId: row.id,
        newValue: { materials_issued: true, issued_by_name: name },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const shortItems = (items.data ?? []).filter(
    (it) => (it.raw_materials?.current_stock ?? 0) < Number(it.quantity_requested),
  );

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Issue Materials — {row.request_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          For {row.products?.name} · {num(Number(row.quantity_requested))} {row.unit}
        </p>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Available</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(items.data ?? []).map((it) => {
                const short =
                  (it.raw_materials?.current_stock ?? 0) < Number(it.quantity_requested);
                return (
                  <TableRow key={it.id}>
                    <TableCell>{it.raw_materials?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {num(Number(it.quantity_requested))} {it.unit ?? it.raw_materials?.unit}
                    </TableCell>
                    <TableCell
                      className={`text-right ${short ? "text-destructive font-medium" : ""}`}
                    >
                      {num(Number(it.raw_materials?.current_stock ?? 0))}{" "}
                      {it.unit ?? it.raw_materials?.unit}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div>
          <Label>Issued by</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Store keeper name"
          />
        </div>
        {shortItems.length > 0 && (
          <p className="text-xs text-destructive">
            Insufficient stock for {shortItems.length} material{shortItems.length === 1 ? "" : "s"}{" "}
            — issuing will fail until stock is replenished.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || !name.trim()} onClick={() => submit.mutate()}>
          {submit.isPending ? "Issuing…" : "Issue Materials"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DetailDialog({
  row,
  fetchItems,
}: {
  row: RequestRow;
  fetchItems: (id: string) => Promise<RequestItem[]>;
}) {
  const items = useQuery({
    queryKey: ["production-request-items", row.id],
    queryFn: () => fetchItems(row.id),
  });

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
            <span className="text-muted-foreground">
              {row.request_type === "purchase" ? "Material" : "Product"}:
            </span>{" "}
            {row.request_type === "purchase"
              ? (row.raw_materials?.name ?? "—")
              : (row.products?.name ?? "—")}
          </div>
          <div>
            <span className="text-muted-foreground">Quantity:</span>{" "}
            {num(Number(row.quantity_requested))} {row.unit}
          </div>
          {row.request_type === "purchase" && (
            <div>
              <span className="text-muted-foreground">Supplier:</span> {row.suppliers?.name ?? "—"}
            </div>
          )}
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
            <span className="text-muted-foreground">Approval date:</span>{" "}
            {row.approval_date ? new Date(row.approval_date).toLocaleString() : "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Materials issued:</span>{" "}
            {row.materials_issued ? "Yes" : "No"}
          </div>
          <div>
            <span className="text-muted-foreground">Issued by:</span> {row.issued_by_name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Production status:</span>{" "}
            <Badge variant={productionStatusBadge(row.production_status)} className="capitalize">
              {row.production_status.replace(/_/g, " ")}
            </Badge>
          </div>
          {row.production && (
            <div>
              <span className="text-muted-foreground">Production #:</span>{" "}
              {row.production.production_number}
            </div>
          )}
        </div>
        {row.remarks && (
          <div>
            <span className="text-muted-foreground">Remarks:</span> {row.remarks}
          </div>
        )}
        {row.request_type === "production_material" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Issued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(items.data ?? []).map((it) => (
                <TableRow key={it.id}>
                  <TableCell>{it.raw_materials?.name ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {num(Number(it.quantity_requested))} {it.unit ?? it.raw_materials?.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(Number(it.quantity_issued))} {it.unit ?? it.raw_materials?.unit}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </DialogContent>
  );
}
