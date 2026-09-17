import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useEffect, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { money, num } from "@/lib/format";
import { toast } from "sonner";
import {
  Plus,
  PackagePlus,
  PackageMinus,
  SlidersHorizontal,
  Printer,
  Pencil,
  History,
  Boxes,
  AlertTriangle,
  Wallet,
  ArrowLeftRight,
  Send,
  Ban,
  Undo2,
  ShoppingCart,
  Check,
  X,
} from "lucide-react";
import { generateStockCardPdf } from "@/lib/pdf";
import {
  useUnitsOfMeasure,
  UNIT_OPTIONS as UNIT_OPTIONS_FALLBACK,
  getUnitOptionsForCategory,
} from "@/lib/units";
import { ADJUSTMENT_REASONS } from "@/lib/adjustment-reasons";

export const Route = createFileRoute("/_app/raw-materials")({
  head: () => ({
    meta: [{ title: "Raw Materials — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="raw-materials">
      <RawMaterialsPage />
    </RequireAccess>
  ),
});

type Supplier = { id: string; name: string };
type MaterialCategory = { id: string; name: string };
type Material = {
  id: string;
  name: string;
  category: string | null;
  category_id: string | null;
  unit: string;
  opening_stock: number;
  current_stock: number;
  unit_cost: number;
  reorder_level: number | null;
  minimum_stock: number | null;
  active: boolean;
  approval_status: string;
  created_by: string | null;
  remarks: string | null;
  supplier_id: string | null;
  suppliers: { name: string } | null;
  material_categories: { name: string } | null;
};
type Factory = { id: string; code: string; name: string };
type Movement = {
  id: string;
  movement_type: string;
  quantity: number;
  unit_cost: number | null;
  reference: string | null;
  reason: string | null;
  user_id: string | null;
  created_at: string;
  quantity_before: number | null;
  quantity_after: number | null;
};
type PendingAdjustment = {
  id: string;
  reference_number: string;
  material_id: string | null;
  quantity_delta: number;
  reason: string | null;
  submitted_by: string;
  submitted_at: string;
  status: string;
  raw_materials: { name: string; unit: string } | null;
};
type PendingReceipt = {
  id: string;
  receipt_number: string;
  material_id: string;
  quantity: number;
  damaged_quantity: number;
  accepted_quantity: number;
  status: string;
  submitted_by: string;
  submitted_at: string;
  raw_materials: { name: string; unit: string } | null;
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone = "primary",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "primary" | "warning" | "destructive";
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold">{value}</div>
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${toneClasses}`}>
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function RawMaterialsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canWrite, canApprove, canPost, canCancel, canSubmit, canConfirm, canReject } =
    usePermissions();
  const write = canWrite("raw-materials");
  const approve = canApprove("raw-materials");
  const post = canPost("raw-materials");
  const cancel = canCancel("raw-materials");
  const canSubmitPurchase = canSubmit("production-requests");
  const submitMaterial = canSubmit("raw-materials");
  const confirmReceipt_ = canConfirm("goods-receiving");
  const rejectReceipt_ = canReject("goods-receiving");
  const cancelReceipt_ = canCancel("goods-receiving");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<Material | null>(null);
  const [issueTarget, setIssueTarget] = useState<Material | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<Material | null>(null);
  const [transferTarget, setTransferTarget] = useState<Material | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Material | null>(null);
  const [purchaseTarget, setPurchaseTarget] = useState<Material | null>(null);

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

  const factories = useQuery({
    queryKey: ["factories-all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,code,name").order("name");
      if (error) throw error;
      return (data ?? []) as Factory[];
    },
  });

  const list = useQuery({
    queryKey: ["raw-materials-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select(
          "id,name,category,category_id,unit,opening_stock,current_stock,unit_cost,reorder_level,minimum_stock,active,approval_status,created_by,remarks,supplier_id,suppliers(name),material_categories(name)",
        )
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Material[];
    },
  });

  const materialCategories = useQuery({
    queryKey: ["material-categories", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("material_categories")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as MaterialCategory[];
    },
  });

  const pendingAdjustments = useQuery({
    queryKey: ["stock-adjustment-requests", "raw_material", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_adjustment_requests")
        .select(
          "id,reference_number,material_id,quantity_delta,reason,submitted_by,submitted_at,status,raw_materials(name,unit)",
        )
        .eq("factory_id", factoryId!)
        .eq("entity_type", "raw_material")
        .in("status", ["pending_approval", "approved"])
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PendingAdjustment[];
    },
  });

  const pendingReceipts = useQuery({
    queryKey: ["goods-receipts", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select(
          "id,receipt_number,material_id,quantity,damaged_quantity,accepted_quantity,status,submitted_by,submitted_at,raw_materials(name,unit)",
        )
        .eq("factory_id", factoryId!)
        .eq("status", "pending_confirmation")
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PendingReceipt[];
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const recentDamage = useQuery({
    queryKey: ["damage-records-raw-materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("damage_records")
        .select(
          "id,reference_number,source_type,source_reference,quantity,unit,reason,created_at,raw_materials(name)",
        )
        .eq("factory_id", factoryId!)
        .not("material_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string;
        reference_number: string;
        source_type: string;
        source_reference: string | null;
        quantity: number;
        unit: string | null;
        reason: string | null;
        created_at: string;
        raw_materials: { name: string } | null;
      }[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
    qc.invalidateQueries({ queryKey: ["material-movements"] });
    qc.invalidateQueries({ queryKey: ["stock-adjustment-requests"] });
    qc.invalidateQueries({ queryKey: ["goods-receipts"] });
  };

  const confirmReceipt = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("confirm_goods_receipt", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Receipt confirmed — posted to stock");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectReceipt = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("reject_goods_receipt", {
        p_id: id,
        p_reason: "Rejected",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Receipt rejected");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelReceipt = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_goods_receipt", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Receipt cancelled");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviewAdjustment = useMutation({
    mutationFn: async ({
      id,
      approve: doApprove,
      reason,
    }: {
      id: string;
      approve: boolean;
      reason?: string;
    }) => {
      const { error } = await supabase.rpc(
        doApprove ? "approve_stock_adjustment" : "reject_stock_adjustment",
        doApprove ? { p_id: id } : { p_id: id, p_reason: reason },
      );
      if (error) throw error;
    },
    onSuccess: (_r, vars) => {
      toast.success(
        vars.approve ? "Adjustment approved — post it next to apply" : "Adjustment rejected",
      );
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const postAdjustment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("post_stock_adjustment", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Write-off posted");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelAdjustment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_stock_adjustment", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Write-off request cancelled");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async (m: Material) => {
      const { error } = await supabase
        .from("raw_materials")
        .update({ active: !m.active })
        .eq("id", m.id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(),
    onError: (e: Error) => toast.error(e.message),
  });

  const approveMaterial = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("approve_new_material", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Material approved — now active");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectMaterial = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("reject_new_material", {
        p_id: id,
        p_reason: "Rejected",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Material rejected");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const summary = {
    totalValue: (list.data ?? []).reduce(
      (s, m) => s + Number(m.current_stock) * Number(m.unit_cost),
      0,
    ),
    lowStock: (list.data ?? []).filter(
      (m) => Number(m.current_stock) <= Number(m.reorder_level ?? 0),
    ).length,
    totalMaterials: (list.data ?? []).length,
  };

  const printCard = async (m: Material) => {
    const { data, error } = await supabase
      .from("raw_material_movements")
      .select("movement_type,quantity,reference,reason,created_at")
      .eq("material_id", m.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      toast.error(error.message);
      return;
    }
    generateStockCardPdf({
      company: {
        name: settings.data?.company_name ?? "FMIS",
        address: settings.data?.address,
        phone: settings.data?.phone,
        logo_url: settings.data?.logo_url,
      },
      title: "Raw Material Card",
      item_name: m.name,
      unit: m.unit,
      current_stock: Number(m.current_stock),
      unit_cost: Number(m.unit_cost),
      total_value: Number(m.current_stock) * Number(m.unit_cost),
      reorder_level: m.reorder_level,
      extra: [
        ["Category", m.material_categories?.name || m.category || "—"],
        ["Supplier", m.suppliers?.name || "—"],
      ],
      movements: (data ?? []).map((mv: any) => ({
        date: new Date(mv.created_at).toLocaleDateString(),
        type: mv.movement_type,
        quantity: Number(mv.quantity),
        reference: mv.reference,
        reason: mv.reason,
      })),
      currency: settings.data?.currency ?? "NGN",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Raw Materials</h1>
          <p className="text-sm text-muted-foreground">
            Stock, receipts, issues to production, and reorder alerts.
          </p>
        </div>
        {(write || submitMaterial) && (
          <Dialog
            open={formOpen}
            onOpenChange={(v) => {
              setFormOpen(v);
              if (!v) setEditing(null);
            }}
          >
            <DialogTrigger asChild>
              <Button className="gap-2" onClick={() => setEditing(null)}>
                <Plus className="h-4 w-4" /> Add Material
              </Button>
            </DialogTrigger>
            {formOpen && factoryId && (
              <MaterialForm
                factoryId={factoryId}
                suppliers={suppliers.data ?? []}
                categories={materialCategories.data ?? []}
                editing={editing}
                onDone={() => {
                  setFormOpen(false);
                  setEditing(null);
                  invalidateAll();
                  qc.invalidateQueries({ queryKey: ["material-categories"] });
                }}
              />
            )}
          </Dialog>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard icon={Boxes} label="Total Materials" value={String(summary.totalMaterials)} />
        <SummaryCard icon={Wallet} label="Inventory Value" value={money(summary.totalValue)} />
        <SummaryCard
          icon={AlertTriangle}
          label="Low Stock / Reorder Alerts"
          value={String(summary.lowStock)}
          tone={summary.lowStock > 0 ? "destructive" : "warning"}
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Materials</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Current Stock</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Total Value</TableHead>
                <TableHead>Reorder Level</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((m) => {
                const low = Number(m.current_stock) <= Number(m.reorder_level ?? 0);
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      {m.name}
                      {m.approval_status === "pending_approval" && (
                        <Badge variant="outline" className="ml-2">
                          Pending Approval
                        </Badge>
                      )}
                      {m.approval_status === "rejected" && (
                        <Badge variant="destructive" className="ml-2">
                          Rejected
                        </Badge>
                      )}
                      {m.approval_status === "approved" && !m.active && (
                        <Badge variant="outline" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{m.material_categories?.name ?? m.category ?? "—"}</TableCell>
                    <TableCell>{m.suppliers?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <span className={low ? "text-destructive font-medium" : ""}>
                        {num(Number(m.current_stock))} {m.unit}
                      </span>
                      {low && (
                        <Badge variant="destructive" className="ml-2">
                          Low
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(m.unit_cost))}</TableCell>
                    <TableCell className="text-right font-medium">
                      {money(Number(m.current_stock) * Number(m.unit_cost))}
                    </TableCell>
                    <TableCell>
                      {num(Number(m.reorder_level ?? 0))} {m.unit}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {m.approval_status === "pending_approval" ? (
                          <>
                            {approve && m.created_by !== currentUser.data && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Approve"
                                  onClick={() => approveMaterial.mutate(m.id)}
                                >
                                  <Check className="h-4 w-4 text-success" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Reject"
                                  onClick={() => rejectMaterial.mutate(m.id)}
                                >
                                  <X className="h-4 w-4 text-destructive" />
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditing(m);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Submit Goods Receipt"
                              onClick={() => setReceiveTarget(m)}
                            >
                              <PackagePlus className="h-4 w-4 text-success" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Issue Stock"
                              onClick={() => setIssueTarget(m)}
                            >
                              <PackageMinus className="h-4 w-4 text-warning" />
                            </Button>
                            {low && canSubmitPurchase && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Request purchase"
                                onClick={() => setPurchaseTarget(m)}
                              >
                                <ShoppingCart className="h-4 w-4 text-destructive" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Adjust Stock"
                              onClick={() => setAdjustTarget(m)}
                            >
                              <SlidersHorizontal className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Transfer"
                              onClick={() => setTransferTarget(m)}
                            >
                              <ArrowLeftRight className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="History"
                              onClick={() => setHistoryTarget(m)}
                            >
                              <History className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Print"
                              onClick={() => printCard(m)}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditing(m);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title={m.active ? "Deactivate" : "Activate"}
                              onClick={() => toggleActive.mutate(m)}
                            >
                              {m.active ? "Deactivate" : "Activate"}
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No raw materials yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(pendingReceipts.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle>Pending Goods Receipts</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt #</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Damaged</TableHead>
                  <TableHead className="text-right">Accepted</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pendingReceipts.data ?? []).map((r) => {
                  const isSelf = r.submitted_by === currentUser.data;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.receipt_number}</TableCell>
                      <TableCell>{r.raw_materials?.name ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {num(Number(r.quantity))} {r.raw_materials?.unit ?? ""}
                      </TableCell>
                      <TableCell className="text-right text-destructive">
                        {Number(r.damaged_quantity) > 0
                          ? `${num(Number(r.damaged_quantity))} ${r.raw_materials?.unit ?? ""}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {num(Number(r.accepted_quantity))} {r.raw_materials?.unit ?? ""}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {r.status.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.submitted_at).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {confirmReceipt_ && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Confirm"
                              onClick={() => confirmReceipt.mutate(r.id)}
                            >
                              <Check className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {rejectReceipt_ && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Reject"
                              onClick={() => rejectReceipt.mutate(r.id)}
                            >
                              <X className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                          {cancelReceipt_ && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Cancel"
                              onClick={() => cancelReceipt.mutate(r.id)}
                            >
                              <Ban className="h-4 w-4 text-muted-foreground" />
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

      {(pendingAdjustments.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle>Pending Stock Adjustment Requests</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pendingAdjustments.data ?? []).map((a) => {
                  const isSelf = a.submitted_by === currentUser.data;
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="font-mono text-xs">{a.reference_number}</TableCell>
                      <TableCell className="font-medium">{a.raw_materials?.name ?? "—"}</TableCell>
                      <TableCell className="text-right text-destructive">
                        {num(Number(a.quantity_delta))} {a.raw_materials?.unit ?? ""}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{a.reason ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {a.status.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(a.submitted_at).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {a.status === "pending_approval" && approve && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Approve"
                              onClick={() => reviewAdjustment.mutate({ id: a.id, approve: true })}
                            >
                              <PackagePlus className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {a.status === "pending_approval" && approve && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Reject"
                              onClick={() =>
                                reviewAdjustment.mutate({
                                  id: a.id,
                                  approve: false,
                                  reason: "Rejected",
                                })
                              }
                            >
                              <PackageMinus className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                          {a.status === "approved" && post && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Post"
                              onClick={() => postAdjustment.mutate(a.id)}
                            >
                              <Send className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {(a.status === "pending_approval" || a.status === "approved") &&
                            cancel && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Cancel"
                                onClick={() => cancelAdjustment.mutate(a.id)}
                              >
                                <Ban className="h-4 w-4 text-muted-foreground" />
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

      {(recentDamage.data ?? []).length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Recent Damage</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recentDamage.data ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{d.reference_number}</TableCell>
                    <TableCell>{d.raw_materials?.name ?? "—"}</TableCell>
                    <TableCell className="text-right text-destructive">
                      {num(Number(d.quantity))} {d.unit ?? ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {d.source_type.toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.reason ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(d.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!receiveTarget} onOpenChange={(v) => !v && setReceiveTarget(null)}>
        {receiveTarget && (
          <ReceiveDialog
            material={receiveTarget}
            suppliers={suppliers.data ?? []}
            onDone={() => {
              setReceiveTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!issueTarget} onOpenChange={(v) => !v && setIssueTarget(null)}>
        {issueTarget && (
          <IssueDialog
            material={issueTarget}
            onDone={() => {
              setIssueTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!adjustTarget} onOpenChange={(v) => !v && setAdjustTarget(null)}>
        {adjustTarget && (
          <AdjustDialog
            material={adjustTarget}
            onDone={() => {
              setAdjustTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!transferTarget} onOpenChange={(v) => !v && setTransferTarget(null)}>
        {transferTarget && (
          <TransferDialog
            material={transferTarget}
            factories={(factories.data ?? []).filter((f) => f.id !== factoryId)}
            onDone={() => {
              setTransferTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!historyTarget} onOpenChange={(v) => !v && setHistoryTarget(null)}>
        {historyTarget && <HistoryDialog material={historyTarget} />}
      </Dialog>
      <Dialog open={!!purchaseTarget} onOpenChange={(v) => !v && setPurchaseTarget(null)}>
        {purchaseTarget && (
          <RequestPurchaseDialog
            material={purchaseTarget}
            onDone={() => {
              setPurchaseTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function MaterialForm({
  factoryId,
  suppliers,
  categories,
  editing,
  onDone,
}: {
  factoryId: string;
  suppliers: Supplier[];
  categories: MaterialCategory[];
  editing: Material | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const unitsOfMeasure = useUnitsOfMeasure();
  const allUnitOptions = unitsOfMeasure.data ?? UNIT_OPTIONS_FALLBACK;
  const [name, setName] = useState(editing?.name ?? "");
  const [categoryId, setCategoryId] = useState(editing?.category_id ?? "none");
  const selectedCategoryName = categories.find((c) => c.id === categoryId)?.name;
  const unitOptions = getUnitOptionsForCategory(selectedCategoryName, allUnitOptions);
  const [newCategory, setNewCategory] = useState("");
  const initialUnit = editing?.unit ?? "kg";
  const [unitChoice, setUnitChoice] = useState(
    unitOptions.includes(initialUnit) ? initialUnit : "__custom__",
  );
  const [customUnit, setCustomUnit] = useState(
    unitOptions.includes(initialUnit) ? "" : initialUnit,
  );
  const unit = unitChoice === "__custom__" ? customUnit : unitChoice;

  // Bottle/Sachet/Dispenser only take kg or pieces — if the category changes
  // to/from one of those, drop a unit choice that's no longer offered.
  useEffect(() => {
    if (unitChoice !== "__custom__" && !unitOptions.includes(unitChoice)) {
      setUnitChoice(unitOptions[0] ?? "__custom__");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategoryName, allUnitOptions]);

  const [openingStock, setOpeningStock] = useState(editing ? Number(editing.opening_stock) : 0);
  const [unitCost, setUnitCost] = useState(editing ? Number(editing.unit_cost) : 0);
  const [supplierId, setSupplierId] = useState(editing?.supplier_id ?? "none");
  const [reorderLevel, setReorderLevel] = useState(
    editing ? Number(editing.reorder_level ?? 0) : 0,
  );
  const [minimumStock, setMinimumStock] = useState(
    editing ? Number(editing.minimum_stock ?? 0) : 0,
  );
  const [remarks, setRemarks] = useState(editing?.remarks ?? "");

  const addCategory = useMutation({
    mutationFn: async () => {
      if (!newCategory.trim()) throw new Error("Enter a category name");
      const { data, error } = await supabase
        .from("material_categories")
        .insert({ factory_id: factoryId, name: newCategory.trim() })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      setCategoryId(id);
      setNewCategory("");
      qc.invalidateQueries({ queryKey: ["material-categories"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [newSupplier, setNewSupplier] = useState("");
  const addSupplier = useMutation({
    mutationFn: async () => {
      if (!newSupplier.trim()) throw new Error("Enter a supplier name");
      const { data, error } = await supabase
        .from("suppliers")
        .insert({ factory_id: factoryId, name: newSupplier.trim() })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      setSupplierId(id);
      setNewSupplier("");
      // Registers the supplier for real, on the same `suppliers` table the
      // Suppliers page reads — it shows up there and in every other
      // supplier dropdown without being re-entered.
      qc.invalidateQueries({ queryKey: ["suppliers-brief"] });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Material name is required");
      if (!unit.trim()) throw new Error("Select or enter a unit of measurement");
      const payload = {
        name: name.trim(),
        category_id: categoryId === "none" ? null : categoryId,
        unit: unit.trim(),
        unit_cost: unitCost,
        supplier_id: supplierId === "none" ? null : supplierId,
        reorder_level: reorderLevel,
        minimum_stock: minimumStock,
        remarks: remarks || null,
      };
      if (editing) {
        const { error } = await supabase.from("raw_materials").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        // New materials go through a maker-checker gate (request_new_material ->
        // approve/reject_new_material) rather than an instant table insert, so
        // critical master data can't be created silently without authorization.
        const { error } = await supabase.rpc("request_new_material", {
          payload: { ...payload, factory_id: factoryId, opening_stock: openingStock } as any,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Material updated" : "Material submitted — awaiting approval");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Material" : "Add New Material"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[75vh] overflow-y-auto pr-1">
        <div>
          <Label>Raw material name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Unit of measurement</Label>
            <Select value={unitChoice} onValueChange={setUnitChoice}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {unitOptions.map((u) => (
                  <SelectItem key={u} value={u} className="capitalize">
                    {u}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">Other…</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex gap-2">
          <Input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="New category name…"
            className="h-8"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!newCategory.trim() || addCategory.isPending}
            onClick={() => addCategory.mutate()}
          >
            Add
          </Button>
        </div>
        {unitChoice === "__custom__" && (
          <div>
            <Label>Custom unit</Label>
            <Input
              value={customUnit}
              onChange={(e) => setCustomUnit(e.target.value)}
              placeholder="e.g. crates"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Opening stock</Label>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={openingStock}
              onChange={(e) => setOpeningStock(Number(e.target.value))}
              disabled={!!editing}
            />
          </div>
          <div>
            <Label>Unit cost</Label>
            <MoneyInput value={unitCost} onChange={setUnitCost} />
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
          <div className="flex gap-2 mt-2">
            <Input
              value={newSupplier}
              onChange={(e) => setNewSupplier(e.target.value)}
              placeholder="New supplier name…"
              className="h-8"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!newSupplier.trim() || addSupplier.isPending}
              onClick={() => addSupplier.mutate()}
            >
              Add
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Minimum stock</Label>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={minimumStock}
              onChange={(e) => setMinimumStock(Number(e.target.value))}
            />
          </div>
          <div>
            <Label>Reorder level</Label>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={reorderLevel}
              onChange={(e) => setReorderLevel(Number(e.target.value))}
            />
          </div>
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Add material"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ReceiveDialog({
  material,
  suppliers,
  onDone,
}: {
  material: Material;
  suppliers: Supplier[];
  onDone: () => void;
}) {
  const [quantity, setQuantity] = useState(0);
  const [damagedQuantity, setDamagedQuantity] = useState(0);
  const [unitCost, setUnitCost] = useState(Number(material.unit_cost));
  const [supplierId, setSupplierId] = useState(material.supplier_id ?? "none");
  const [deliveryReference, setDeliveryReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const accepted = Math.max(quantity - damagedQuantity, 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      if (damagedQuantity < 0 || damagedQuantity > quantity)
        throw new Error("Damaged quantity must be between 0 and the received quantity");
      const { error } = await supabase.rpc("submit_goods_receipt", {
        payload: {
          material_id: material.id,
          quantity,
          damaged_quantity: damagedQuantity,
          unit_cost: unitCost,
          supplier_id: supplierId === "none" ? null : supplierId,
          delivery_reference: deliveryReference || null,
          remarks: remarks || null,
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
        <DialogTitle>Submit Goods Receipt — {material.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Dual control: this only posts to stock once someone else confirms it.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Quantity received</Label>
            <Input
              type="number"
              min={0.001}
              step="0.001"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </div>
          <div>
            <Label>Damaged quantity</Label>
            <Input
              type="number"
              min={0}
              max={quantity}
              step="0.001"
              value={damagedQuantity}
              onChange={(e) => setDamagedQuantity(Number(e.target.value))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Accepted quantity: {num(accepted)} {material.unit} — only this posts to stock; damaged
          goes to the damage ledger.
        </p>
        <div>
          <Label>Unit cost</Label>
          <MoneyInput value={unitCost} onChange={setUnitCost} />
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

function RequestPurchaseDialog({ material, onDone }: { material: Material; onDone: () => void }) {
  const { data: factoryId } = useFactoryId();
  const [quantity, setQuantity] = useState(
    Math.max(Number(material.reorder_level ?? 0) * 2 - Number(material.current_stock), 0),
  );
  const [requestedByName, setRequestedByName] = useState("");
  const [remarks, setRemarks] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      if (!requestedByName.trim()) throw new Error("Your name is required");
      const { error } = await supabase.rpc("create_production_request", {
        payload: {
          factory_id: factoryId,
          requested_by_name: requestedByName,
          request_type: "purchase",
          material_id: material.id,
          quantity_requested: quantity,
          unit: material.unit,
          supplier_id: material.supplier_id,
          remarks: remarks || null,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Purchase request submitted for approval");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Request Purchase — {material.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Low stock: {num(Number(material.current_stock))} {material.unit} on hand, reorder level{" "}
          {num(Number(material.reorder_level ?? 0))}.
        </p>
        <p className="text-xs text-muted-foreground">
          Supplier: {material.suppliers?.name ?? "— none on file —"}
        </p>
        <div>
          <Label>Your name</Label>
          <Input value={requestedByName} onChange={(e) => setRequestedByName(e.target.value)} />
        </div>
        <div>
          <Label>Quantity to request</Label>
          <Input
            type="number"
            min={0.001}
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || quantity <= 0} onClick={() => submit.mutate()}>
          {submit.isPending ? "Submitting…" : "Submit Request"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function IssueDialog({ material, onDone }: { material: Material; onDone: () => void }) {
  const [quantity, setQuantity] = useState(0);
  const [purpose, setPurpose] = useState<"production" | "general">("production");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      const { error } = await supabase.rpc("issue_raw_material", {
        payload: {
          material_id: material.id,
          quantity,
          purpose,
          reason: reason || null,
          reference: reference || null,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(purpose === "production" ? "Used for production" : "Stock issued");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Issue Stock — {material.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Available: {num(Number(material.current_stock))} {material.unit}
        </p>
        <div>
          <Label>Purpose</Label>
          <Select value={purpose} onValueChange={(v) => setPurpose(v as typeof purpose)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="production">Used for production</SelectItem>
              <SelectItem value="general">General issue</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Quantity issued</Label>
          <Input
            type="number"
            min={0.001}
            max={Number(material.current_stock)}
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </div>
        <div>
          <Label>{purpose === "production" ? "Production reference" : "Reference"}</Label>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={purpose === "production" ? "Batch / production number" : "Optional"}
          />
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || quantity <= 0 || quantity > Number(material.current_stock)}
          onClick={() => submit.mutate()}
        >
          {submit.isPending
            ? "Saving…"
            : purpose === "production"
              ? "Use for Production"
              : "Issue Stock"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function AdjustDialog({ material, onDone }: { material: Material; onDone: () => void }) {
  const oldQuantity = Number(material.current_stock);
  const [newQuantity, setNewQuantity] = useState(oldQuantity);
  const [reasonCategory, setReasonCategory] = useState<string>(ADJUSTMENT_REASONS[0]);
  const [otherDetail, setOtherDetail] = useState("");
  const delta = newQuantity - oldQuantity;
  const reason = reasonCategory === "Other" ? otherDetail.trim() : reasonCategory;

  const submit = useMutation({
    mutationFn: async () => {
      if (delta === 0)
        throw new Error("New quantity is the same as the current stock — enter a different value");
      if (!reason) throw new Error("Describe the reason for this adjustment");
      const { error } = await supabase.rpc("request_stock_adjustment", {
        payload: {
          entity_type: "raw_material",
          material_id: material.id,
          quantity_delta: delta,
          reason,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Submitted for approval");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Adjust Stock — {material.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Old quantity</Label>
            <Input type="number" value={oldQuantity} disabled />
          </div>
          <div>
            <Label>New quantity</Label>
            <Input
              type="number"
              step="0.001"
              value={newQuantity}
              onChange={(e) => setNewQuantity(Number(e.target.value))}
            />
          </div>
          <div>
            <Label>Difference</Label>
            <Input
              value={`${delta > 0 ? "+" : ""}${num(delta)} ${material.unit}`}
              disabled
              className={delta < 0 ? "text-destructive" : delta > 0 ? "text-success" : ""}
            />
          </div>
        </div>
        <div>
          <Label>Reason</Label>
          <Select value={reasonCategory} onValueChange={setReasonCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADJUSTMENT_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {reasonCategory === "Other" && (
          <div>
            <Label>Describe the reason</Label>
            <Textarea
              rows={2}
              value={otherDetail}
              onChange={(e) => setOtherDetail(e.target.value)}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Both increases and reductions require a second person's approval — this submits a request
          instead of adjusting stock immediately.
        </p>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || delta === 0 || !reason}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Submitting…" : "Submit for approval"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function TransferDialog({
  material,
  factories,
  onDone,
}: {
  material: Material;
  factories: Factory[];
  onDone: () => void;
}) {
  const [toFactory, setToFactory] = useState(factories[0]?.id ?? "");
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!toFactory) throw new Error("Select a destination factory");
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      const { error } = await supabase.rpc("transfer_raw_material", {
        payload: {
          material_id: material.id,
          to_factory_id: toFactory,
          quantity,
          reason: reason || null,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Stock transferred");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Transfer — {material.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Available: {num(Number(material.current_stock))} {material.unit}
        </p>
        <div>
          <Label>Destination factory</Label>
          <Select value={toFactory} onValueChange={setToFactory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {factories.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Quantity</Label>
          <Input
            type="number"
            min={0.001}
            max={Number(material.current_stock)}
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || quantity <= 0 || !toFactory}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Transferring…" : "Transfer stock"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function HistoryDialog({ material }: { material: Material }) {
  const movements = useQuery({
    queryKey: ["material-movements", material.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_material_movements")
        .select(
          "id,movement_type,quantity,unit_cost,reference,reason,user_id,created_at,quantity_before,quantity_after",
        )
        .eq("material_id", material.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Movement[];
    },
  });

  const badgeVariant = (type: string) =>
    type === "received"
      ? "secondary"
      : type === "issued" || type === "used_for_production"
        ? "outline"
        : "default";

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>Stock movement — {material.name}</DialogTitle>
      </DialogHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date &amp; Time</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Before</TableHead>
            <TableHead className="text-right">After</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(movements.data ?? []).map((m) => (
            <TableRow key={m.id}>
              <TableCell>{new Date(m.created_at).toLocaleString()}</TableCell>
              <TableCell>
                <Badge variant={badgeVariant(m.movement_type) as any} className="capitalize">
                  {m.movement_type.replace(/_/g, " ")}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {num(Number(m.quantity))} {material.unit}
              </TableCell>
              <TableCell className="text-right text-muted-foreground text-xs">
                {m.quantity_before === null ? "—" : `${num(m.quantity_before)} ${material.unit}`}
              </TableCell>
              <TableCell className="text-right text-xs">
                {m.quantity_after === null ? "—" : `${num(m.quantity_after)} ${material.unit}`}
              </TableCell>
              <TableCell>{m.reference ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{m.reason ?? "—"}</TableCell>
            </TableRow>
          ))}
          {(movements.data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                No movements yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </DialogContent>
  );
}
