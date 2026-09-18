import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
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
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";
import {
  SlidersHorizontal,
  PackageX,
  PackageCheck,
  PackagePlus,
  PackageMinus,
  ArrowLeftRight,
  History,
  Printer,
  Boxes,
  Wallet,
  AlertTriangle,
  Plus,
  Pencil,
  Send,
  Ban,
  Check,
  X,
  Factory,
  Trash2,
  ShoppingCart,
} from "lucide-react";
import { generateStockCardPdf } from "@/lib/pdf";
import { useUnitsOfMeasure, UNIT_OPTIONS as UNIT_OPTIONS_FALLBACK } from "@/lib/units";
import { ADJUSTMENT_REASONS } from "@/lib/adjustment-reasons";
import { PosDialog } from "./_app.sales";

export const Route = createFileRoute("/_app/finished-goods")({
  head: () => ({
    meta: [{ title: "Finished Goods — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="finished-goods">
      <FinishedGoodsPage />
    </RequireAccess>
  ),
});

type Product = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  unit_price: number;
  cost_price: number;
  current_stock: number;
  reorder_level: number | null;
  category_id: string | null;
  product_type: string;
  product_categories: { name: string } | null;
};
type Factory = { id: string; code: string; name: string };
type Category = { id: string; name: string };
type Movement = {
  id: string;
  movement_type: string;
  quantity: number;
  reference: string | null;
  reason: string | null;
  created_at: string;
  quantity_before: number | null;
  quantity_after: number | null;
};
type PendingAdjustment = {
  id: string;
  reference_number: string;
  product_id: string | null;
  quantity_delta: number;
  reason: string | null;
  submitted_by: string;
  submitted_at: string;
  status: string;
  products: { name: string; unit: string } | null;
};
type PendingBatch = {
  id: string;
  production_number: string;
  quantity_produced: number;
  unit: string;
  batch_number: string | null;
  created_by: string | null;
  created_at: string;
  products: { name: string; unit: string } | null;
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

function FinishedGoodsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canWrite, canSubmit, canApprove, canPost, canCancel, canConfirm, canReject } =
    usePermissions();
  const write = canWrite("finished-goods");
  const submit = canSubmit("finished-goods");
  const canSell = canWrite("sales");
  const approve = canApprove("finished-goods");
  const post = canPost("finished-goods");
  const cancel = canCancel("finished-goods");
  const confirmBatchPerm = canConfirm("production");
  const rejectBatchPerm = canReject("production");
  useRealtimeInvalidate(
    [
      "products",
      "product_categories",
      "stock_adjustment_requests",
      "production",
      "inventory_movements",
      "product_price_history",
      "product_units",
      "damage_records",
    ],
    [
      ["finished-goods"],
      ["product-categories"],
      ["stock-adjustment-requests"],
      ["pending-production-batches"],
      ["finished-goods-movements"],
      ["finished-goods-price-history"],
      ["product-units"],
      ["products-active"],
      ["products-for-production"],
      ["production-list"],
      ["damage-records-finished-goods"],
      ["damage-value-finished-goods"],
    ],
  );
  const [formOpen, setFormOpen] = useState(false);
  const [posOpen, setPosOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | "finished" | "semi_finished">("all");
  const [adjustTarget, setAdjustTarget] = useState<{
    product: Product;
    type: "adjusted" | "damaged";
  } | null>(null);
  const [transferTarget, setTransferTarget] = useState<Product | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Product | null>(null);
  const [packagingTarget, setPackagingTarget] = useState<Product | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<PendingBatch | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingBatch | null>(null);

  const list = useQuery({
    queryKey: ["finished-goods", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select(
          "id,name,sku,unit,unit_price,cost_price,current_stock,reorder_level,category_id,product_type,product_categories(name)",
        )
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Product[];
    },
  });

  const categories = useQuery({
    queryKey: ["product-categories", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Category[];
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

  const pendingAdjustments = useQuery({
    queryKey: ["stock-adjustment-requests", "finished_good", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_adjustment_requests")
        .select(
          "id,reference_number,product_id,quantity_delta,reason,submitted_by,submitted_at,status,products(name,unit)",
        )
        .eq("factory_id", factoryId!)
        .eq("entity_type", "finished_good")
        .in("status", ["pending_approval", "approved"])
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PendingAdjustment[];
    },
  });

  const pendingBatches = useQuery({
    queryKey: ["pending-production-batches", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select(
          "id,production_number,quantity_produced,unit,batch_number,created_by,created_at,products(name,unit)",
        )
        .eq("factory_id", factoryId!)
        .eq("status", "pending_confirmation")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PendingBatch[];
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const recentDamage = useQuery({
    queryKey: ["damage-records-finished-goods", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("damage_records")
        .select(
          "id,reference_number,source_type,source_reference,quantity,unit,unit_cost,reason,created_at,products(name)",
        )
        .eq("factory_id", factoryId!)
        .not("product_id", "is", null)
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
        unit_cost: number | null;
        reason: string | null;
        created_at: string;
        products: { name: string } | null;
      }[];
    },
  });

  // Separate from recentDamage (capped at 20 rows for display) so the
  // "Damaged Value" total below reflects every damage record, not just the
  // most recent page of them.
  const damageValue = useQuery({
    queryKey: ["damage-value-finished-goods", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("damage_records")
        .select("quantity,unit_cost")
        .eq("factory_id", factoryId!)
        .not("product_id", "is", null);
      if (error) throw error;
      return (data ?? []).reduce((s, d) => s + Number(d.quantity) * Number(d.unit_cost ?? 0), 0);
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
    qc.invalidateQueries({ queryKey: ["products-active"] });
    qc.invalidateQueries({ queryKey: ["products-for-production"] });
    qc.invalidateQueries({ queryKey: ["stock-adjustment-requests"] });
    qc.invalidateQueries({ queryKey: ["production-list"] });
    qc.invalidateQueries({ queryKey: ["pending-production-batches"] });
    qc.invalidateQueries({ queryKey: ["damage-records-finished-goods"] });
    qc.invalidateQueries({ queryKey: ["damage-value-finished-goods"] });
  };

  const rejectBatch = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reject_production_batch", {
        p_id: id,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Batch rejected");
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

  const filteredList = (list.data ?? []).filter(
    (p) => typeFilter === "all" || p.product_type === typeFilter,
  );

  const summary = {
    totalSkus: filteredList.length,
    totalValue: filteredList.reduce(
      (s, p) => s + Number(p.current_stock) * Number(p.cost_price),
      0,
    ),
    lowStock: filteredList.filter((p) => Number(p.current_stock) <= Number(p.reorder_level ?? 0))
      .length,
  };

  const printCard = async (p: Product) => {
    const { data, error } = await supabase
      .from("inventory_movements")
      .select("movement_type,quantity,reference,reason,created_at")
      .eq("product_id", p.id)
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
      title: "Finished Goods Card",
      item_name: p.name,
      unit: p.unit,
      current_stock: Number(p.current_stock),
      unit_cost: Number(p.cost_price),
      total_value: Number(p.current_stock) * Number(p.cost_price),
      reorder_level: p.reorder_level,
      extra: [
        ["Category", p.product_categories?.name || "—"],
        ["Selling price", money(Number(p.unit_price), settings.data?.currency ?? "NGN")],
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
          <h1 className="text-2xl font-semibold tracking-tight">Finished Goods</h1>
          <p className="text-sm text-muted-foreground">
            Available stock plus production, sales, damages, returns, adjustments, and transfers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canSell && (
            <Dialog open={posOpen} onOpenChange={setPosOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="gap-2">
                  <ShoppingCart className="h-4 w-4" /> New Sale
                </Button>
              </DialogTrigger>
              {posOpen && factoryId && (
                <PosDialog
                  factoryId={factoryId}
                  onDone={() => {
                    setPosOpen(false);
                    invalidateAll();
                    qc.invalidateQueries({ queryKey: ["sales-list"] });
                  }}
                />
              )}
            </Dialog>
          )}
          {write && (
            <Dialog
              open={formOpen}
              onOpenChange={(v) => {
                setFormOpen(v);
                if (!v) setEditing(null);
              }}
            >
              <DialogTrigger asChild>
                <Button className="gap-2" onClick={() => setEditing(null)}>
                  <Plus className="h-4 w-4" /> Add Product
                </Button>
              </DialogTrigger>
              {formOpen && factoryId && (
                <ProductForm
                  factoryId={factoryId}
                  categories={categories.data ?? []}
                  editing={editing}
                  onDone={() => {
                    setFormOpen(false);
                    setEditing(null);
                    invalidateAll();
                  }}
                />
              )}
            </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={Boxes}
          label={typeFilter === "semi_finished" ? "Semi-Finished SKUs" : "Finished Goods SKUs"}
          value={String(summary.totalSkus)}
        />
        <SummaryCard icon={Wallet} label="Inventory Value" value={money(summary.totalValue)} />
        <SummaryCard
          icon={AlertTriangle}
          label="Low Stock Items"
          value={String(summary.lowStock)}
          tone={summary.lowStock > 0 ? "destructive" : "warning"}
        />
        <SummaryCard
          icon={PackageMinus}
          label="Damaged Value"
          value={money(damageValue.data ?? 0)}
          tone={(damageValue.data ?? 0) > 0 ? "destructive" : "primary"}
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Available Stock</CardTitle>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
            <SelectTrigger className="h-9 w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="finished">Finished only</SelectItem>
              <SelectItem value="semi_finished">Semi-Finished only</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Available Stock</TableHead>
                <TableHead className="text-right">Cost Price</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredList.map((p) => {
                const low = Number(p.current_stock) <= Number(p.reorder_level ?? 0);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <Badge variant={p.product_type === "semi_finished" ? "outline" : "secondary"}>
                        {p.product_type === "semi_finished" ? "Semi-Finished" : "Finished"}
                      </Badge>
                    </TableCell>
                    <TableCell>{p.product_categories?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <span className={low ? "text-destructive font-medium" : ""}>
                        {num(Number(p.current_stock))} {p.unit}
                      </span>
                      {low && (
                        <Badge variant="destructive" className="ml-2">
                          Low
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(p.cost_price))}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {write && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            onClick={() => {
                              setEditing(p);
                              setFormOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {submit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Adjust"
                            onClick={() => setAdjustTarget({ product: p, type: "adjusted" })}
                          >
                            <SlidersHorizontal className="h-4 w-4" />
                          </Button>
                        )}
                        {submit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Log Damage"
                            onClick={() => setAdjustTarget({ product: p, type: "damaged" })}
                          >
                            <PackageX className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {write && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Transfer"
                            onClick={() => setTransferTarget(p)}
                          >
                            <ArrowLeftRight className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          title="History"
                          onClick={() => setHistoryTarget(p)}
                        >
                          <History className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Packaging / Conversion"
                          onClick={() => setPackagingTarget(p)}
                        >
                          <PackagePlus className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Print"
                          onClick={() => printCard(p)}
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredList.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No products yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(pendingAdjustments.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Pending Write-off Requests
              <Badge variant="destructive">{pendingAdjustments.data!.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Product</TableHead>
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
                      <TableCell className="font-medium">{a.products?.name ?? "—"}</TableCell>
                      <TableCell className="text-right text-destructive">
                        {num(Number(a.quantity_delta))} {a.products?.unit ?? ""}
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
                              <PackageCheck className="h-4 w-4 text-success" />
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
                              <PackageX className="h-4 w-4 text-destructive" />
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

      {(pendingBatches.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Pending Production Batches to Confirm
              <Badge variant="destructive">{pendingBatches.data!.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch #</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Quantity Produced</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pendingBatches.data ?? []).map((b) => {
                  const isSelf = b.created_by === currentUser.data;
                  return (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs">
                        {b.production_number}
                        {b.batch_number ? ` · ${b.batch_number}` : ""}
                      </TableCell>
                      <TableCell className="font-medium">{b.products?.name ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {num(Number(b.quantity_produced))} {b.products?.unit ?? b.unit}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(b.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {confirmBatchPerm && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Confirm"
                              onClick={() => setConfirmTarget(b)}
                            >
                              <Check className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {rejectBatchPerm && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Reject"
                              onClick={() => setRejectTarget(b)}
                            >
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
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recentDamage.data ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{d.reference_number}</TableCell>
                    <TableCell>{d.products?.name ?? "—"}</TableCell>
                    <TableCell className="text-right text-destructive">
                      {num(Number(d.quantity))} {d.unit ?? ""}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.unit_cost == null ? "—" : money(Number(d.unit_cost))}
                    </TableCell>
                    <TableCell className="text-right font-medium text-destructive">
                      {d.unit_cost == null ? "—" : money(Number(d.quantity) * Number(d.unit_cost))}
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

      <Dialog open={!!confirmTarget} onOpenChange={(v) => !v && setConfirmTarget(null)}>
        {confirmTarget && (
          <ConfirmBatchDialog
            batch={confirmTarget}
            onDone={() => {
              setConfirmTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && (
          <RejectBatchDialog
            batch={rejectTarget}
            isPending={rejectBatch.isPending}
            onReject={(reason) =>
              rejectBatch.mutate(
                { id: rejectTarget.id, reason },
                { onSuccess: () => setRejectTarget(null) },
              )
            }
          />
        )}
      </Dialog>

      <Dialog open={!!adjustTarget} onOpenChange={(v) => !v && setAdjustTarget(null)}>
        {adjustTarget && (
          <AdjustDialog
            product={adjustTarget.product}
            type={adjustTarget.type}
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
            product={transferTarget}
            factories={(factories.data ?? []).filter((f) => f.id !== factoryId)}
            onDone={() => {
              setTransferTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!historyTarget} onOpenChange={(v) => !v && setHistoryTarget(null)}>
        {historyTarget && <HistoryDialog product={historyTarget} />}
      </Dialog>
      <Dialog open={!!packagingTarget} onOpenChange={(v) => !v && setPackagingTarget(null)}>
        {packagingTarget && (
          <PackagingDialog
            product={packagingTarget}
            canWrite={write}
            onDone={() => setPackagingTarget(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

function ProductForm({
  factoryId,
  categories,
  editing,
  onDone,
}: {
  factoryId: string;
  categories: Category[];
  editing: Product | null;
  onDone: () => void;
}) {
  const unitsOfMeasure = useUnitsOfMeasure();
  const unitOptions = unitsOfMeasure.data ?? UNIT_OPTIONS_FALLBACK;
  const [name, setName] = useState(editing?.name ?? "");
  const [sku, setSku] = useState(editing?.sku ?? "");
  const [productType, setProductType] = useState<"finished" | "semi_finished">(
    (editing?.product_type as "finished" | "semi_finished") ?? "finished",
  );
  const initialUnit = editing?.unit ?? "pieces";
  const [unitChoice, setUnitChoice] = useState(
    unitOptions.includes(initialUnit) ? initialUnit : "__custom__",
  );
  const [customUnit, setCustomUnit] = useState(
    unitOptions.includes(initialUnit) ? "" : initialUnit,
  );
  const unit = unitChoice === "__custom__" ? customUnit : unitChoice;
  const [categoryId, setCategoryId] = useState(editing?.category_id ?? "none");
  const [unitPrice, setUnitPrice] = useState(editing ? Number(editing.unit_price) : 0);
  const [costPrice, setCostPrice] = useState(editing ? Number(editing.cost_price) : 0);
  const [openingStock, setOpeningStock] = useState(editing ? Number(editing.current_stock) : 0);
  const [reorderLevel, setReorderLevel] = useState(
    editing ? Number(editing.reorder_level ?? 0) : 0,
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Product name is required");
      if (!unit.trim()) throw new Error("Select or enter a unit of measurement");
      const payload = {
        name: name.trim(),
        sku: sku.trim() || null,
        product_type: productType,
        unit: unit.trim(),
        category_id: categoryId === "none" ? null : categoryId,
        unit_price: unitPrice,
        reorder_level: reorderLevel,
      };
      if (editing) {
        // cost_price is intentionally excluded here — it's only ever set via
        // an approved Costing sheet from this point on, never a direct edit.
        const { error } = await supabase.from("products").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("products").insert({
          ...payload,
          cost_price: costPrice,
          factory_id: factoryId,
          current_stock: openingStock,
          active: true,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Product updated" : "Product added");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Product" : "Add New Product"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Product name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Type</Label>
            <Select
              value={productType}
              onValueChange={(v) => setProductType(v as typeof productType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="finished">Finished product</SelectItem>
                <SelectItem value="semi_finished">Semi-finished product</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>SKU</Label>
            <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Optional" />
          </div>
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
            <Label>Selling price</Label>
            <MoneyInput value={unitPrice} onChange={setUnitPrice} />
          </div>
          <div>
            <Label>Cost price</Label>
            {editing ? (
              <>
                <MoneyInput
                  value={costPrice}
                  onChange={setCostPrice}
                  disabled
                  className="bg-muted"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Set via an approved Costing sheet — see the Costing page.
                </p>
              </>
            ) : (
              <MoneyInput value={costPrice} onChange={setCostPrice} />
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Opening stock</Label>
            <MoneyInput
              min={0}
              step="0.001"
              value={openingStock}
              onChange={setOpeningStock}
              disabled={!!editing}
            />
          </div>
          <div>
            <Label>Reorder level</Label>
            <MoneyInput
              min={0}
              step="0.001"
              value={reorderLevel}
              onChange={setReorderLevel}
            />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Add product"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const typeLabels: Record<string, string> = {
  adjusted: "Adjust stock",
  damaged: "Log Damage",
};

function AdjustDialog({
  product,
  type,
  onDone,
}: {
  product: Product;
  type: "adjusted" | "damaged";
  onDone: () => void;
}) {
  const oldQuantity = Number(product.current_stock);
  const [newQuantity, setNewQuantity] = useState(oldQuantity);
  const [damagedQuantity, setDamagedQuantity] = useState(0);
  const [reasonCategory, setReasonCategory] = useState<string>(
    type === "damaged" ? "Damaged material" : ADJUSTMENT_REASONS[0],
  );
  const [otherDetail, setOtherDetail] = useState("");
  const delta = type === "adjusted" ? newQuantity - oldQuantity : -Math.abs(damagedQuantity);
  const reason = reasonCategory === "Other" ? otherDetail.trim() : reasonCategory;

  const submit = useMutation({
    mutationFn: async () => {
      if (delta === 0)
        throw new Error(
          type === "adjusted"
            ? "New quantity is the same as the current stock — enter a different value"
            : "Enter a non-zero quantity",
        );
      if (!reason) throw new Error("Describe the reason for this adjustment");
      const { error } = await supabase.rpc("request_stock_adjustment", {
        payload: {
          entity_type: "finished_good",
          product_id: product.id,
          quantity_delta: delta,
          reason,
          movement_type: type,
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
        <DialogTitle>
          {typeLabels[type]} — {product.name}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        {type === "adjusted" ? (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Old quantity</Label>
              <Input type="number" value={oldQuantity} disabled />
            </div>
            <div>
              <Label>New quantity</Label>
              <MoneyInput
                step="0.001"
                value={newQuantity}
                onChange={setNewQuantity}
              />
            </div>
            <div>
              <Label>Difference</Label>
              <Input
                value={`${delta > 0 ? "+" : ""}${num(delta)} ${product.unit}`}
                disabled
                className={delta < 0 ? "text-destructive" : delta > 0 ? "text-success" : ""}
              />
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Available: {num(Number(product.current_stock))} {product.unit}
            </p>
            <div>
              <Label>Quantity</Label>
              <MoneyInput
                min={0.001}
                step="0.001"
                value={damagedQuantity}
                onChange={setDamagedQuantity}
              />
            </div>
          </>
        )}
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
          Requires a second person's approval — this submits a request instead of adjusting stock
          immediately.
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

function ConfirmBatchDialog({ batch, onDone }: { batch: PendingBatch; onDone: () => void }) {
  const [actualReceived, setActualReceived] = useState(Number(batch.quantity_produced));
  const [damaged, setDamaged] = useState(0);
  const [rejected, setRejected] = useState(0);
  const accepted = Math.max(actualReceived - damaged - rejected, 0);
  const unit = batch.products?.unit ?? batch.unit;

  const confirm = useMutation({
    mutationFn: async () => {
      if (actualReceived < 0) throw new Error("Actual quantity received must be >= 0");
      if (damaged < 0 || rejected < 0)
        throw new Error("Damaged/rejected quantities cannot be negative");
      if (damaged + rejected > actualReceived)
        throw new Error("Damaged + rejected cannot exceed actual quantity received");
      const { error } = await supabase.rpc("confirm_production_batch", {
        p_id: batch.id,
        p_actual_received: actualReceived,
        p_damaged: damaged,
        p_rejected: rejected,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Confirmed — ${num(accepted)} ${unit} posted to stock`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Factory className="h-5 w-5" /> Confirm Batch — {batch.production_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {batch.products?.name} · Produced: {num(Number(batch.quantity_produced))} {unit}
        </p>
        <div>
          <Label>Actual Quantity Received</Label>
          <MoneyInput
            min={0}
            step="0.001"
            value={actualReceived}
            onChange={setActualReceived}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Damaged Quantity</Label>
            <MoneyInput
              min={0}
              step="0.001"
              value={damaged}
              onChange={setDamaged}
            />
          </div>
          <div>
            <Label>Rejected Quantity</Label>
            <MoneyInput
              min={0}
              step="0.001"
              value={rejected}
              onChange={setRejected}
            />
          </div>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Accepted Quantity (enters stock)
          </div>
          <div className="mt-1 text-xl font-semibold">
            {num(accepted)} {unit}
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "Confirming…" : "Confirm"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectBatchDialog({
  batch,
  isPending,
  onReject,
}: {
  batch: PendingBatch;
  isPending: boolean;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <X className="h-5 w-5 text-destructive" /> Reject Batch — {batch.production_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {batch.products?.name} · Produced: {num(Number(batch.quantity_produced))}{" "}
          {batch.products?.unit ?? batch.unit}
        </p>
        <div>
          <Label>Reason for rejection</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why this batch is being rejected…"
            autoFocus
          />
        </div>
        <p className="text-xs text-muted-foreground">
          This batch will not be posted to stock. The linked production request (if any) reopens so
          Production can submit a fresh batch.
        </p>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={isPending || !trimmed}
          onClick={() => onReject(trimmed)}
        >
          {isPending ? "Rejecting…" : "Reject batch"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function TransferDialog({
  product,
  factories,
  onDone,
}: {
  product: Product;
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
      const { error } = await supabase.rpc("transfer_finished_stock", {
        payload: {
          product_id: product.id,
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
        <DialogTitle>Transfer — {product.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Available: {num(Number(product.current_stock))} {product.unit}
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
          <MoneyInput
            min={0.001}
            max={Number(product.current_stock)}
            step="0.001"
            value={quantity}
            onChange={setQuantity}
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

const movementBadge = (type: string): "default" | "secondary" | "outline" | "destructive" => {
  if (["produced", "received", "returned"].includes(type)) return "secondary";
  if (["sold", "issued", "damaged", "used_for_production"].includes(type)) return "destructive";
  if (type === "transferred") return "outline";
  return "default";
};

type PriceHistoryRow = {
  id: string;
  price: number;
  previous_price: number | null;
  effective_date: string;
  created_by: string | null;
};

function HistoryDialog({ product }: { product: Product }) {
  const movements = useQuery({
    queryKey: ["finished-goods-movements", product.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_movements")
        .select(
          "id,movement_type,quantity,reference,reason,created_at,quantity_before,quantity_after",
        )
        .eq("product_id", product.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Movement[];
    },
  });

  const priceHistory = useQuery({
    queryKey: ["finished-goods-price-history", product.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_price_history")
        .select("id,price,previous_price,effective_date,created_by")
        .eq("product_id", product.id)
        .order("effective_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as PriceHistoryRow[];
    },
  });

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>Stock movement — {product.name}</DialogTitle>
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
                <Badge variant={movementBadge(m.movement_type)} className="capitalize">
                  {m.movement_type.replace(/_/g, " ")}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {num(Number(m.quantity))} {product.unit}
              </TableCell>
              <TableCell className="text-right text-muted-foreground text-xs">
                {m.quantity_before === null ? "—" : `${num(m.quantity_before)} ${product.unit}`}
              </TableCell>
              <TableCell className="text-right text-xs">
                {m.quantity_after === null ? "—" : `${num(m.quantity_after)} ${product.unit}`}
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

      <h3 className="mt-4 text-sm font-medium">Price history</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Effective</TableHead>
            <TableHead className="text-right">Previous price</TableHead>
            <TableHead className="text-right">New price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(priceHistory.data ?? []).map((h) => (
            <TableRow key={h.id}>
              <TableCell>{new Date(h.effective_date).toLocaleString()}</TableCell>
              <TableCell className="text-right text-muted-foreground">
                {h.previous_price === null ? "—" : money(Number(h.previous_price))}
              </TableCell>
              <TableCell className="text-right font-medium">{money(Number(h.price))}</TableCell>
            </TableRow>
          ))}
          {(priceHistory.data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                No price history yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </DialogContent>
  );
}

type ProductUnitRow = {
  id: string;
  base_unit: string;
  packaging_unit: string;
  conversion_factor: number;
  active: boolean;
};

// Configurable packaging/conversion rules for this product (spec §8): e.g.
// "1 carton = 12 pieces". Production entry uses these to let a user type
// "500 cartons" while quantity_produced (and every downstream stock figure)
// stays in the product's base unit -- nothing here changes current_stock
// itself, it's pure configuration read by create_production().
function PackagingDialog({
  product,
  canWrite,
  onDone,
}: {
  product: Product;
  canWrite: boolean;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [packagingUnit, setPackagingUnit] = useState("");
  const [conversionFactor, setConversionFactor] = useState<number | "">("");
  const [deleteTarget, setDeleteTarget] = useState<ProductUnitRow | null>(null);

  const rules = useQuery({
    queryKey: ["product-units", product.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_units")
        .select("id,base_unit,packaging_unit,conversion_factor,active")
        .eq("product_id", product.id)
        .order("packaging_unit");
      if (error) throw error;
      return (data ?? []) as ProductUnitRow[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["product-units", product.id] });

  const add = useMutation({
    mutationFn: async () => {
      if (!packagingUnit.trim()) throw new Error("Packaging unit is required");
      if (!conversionFactor || conversionFactor <= 0)
        throw new Error("Conversion factor must be > 0");
      const { error } = await supabase.from("product_units").insert({
        product_id: product.id,
        base_unit: product.unit,
        packaging_unit: packagingUnit.trim().toLowerCase(),
        conversion_factor: conversionFactor,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Packaging rule added");
      setPackagingUnit("");
      setConversionFactor("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async (rule: ProductUnitRow) => {
      const { error } = await supabase
        .from("product_units")
        .update({ active: !rule.active })
        .eq("id", rule.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await requestDelete("product_units", id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Packaging / Conversion — {product.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4">
        <p className="text-xs text-muted-foreground">
          Base unit: <span className="font-medium text-foreground">{product.unit}</span>. Each rule
          below lets Production enter a quantity in a packaging unit (e.g. cartons) and have it
          converted to {product.unit} automatically.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Packaging unit</TableHead>
              <TableHead className="text-right">1 unit =</TableHead>
              <TableHead>Status</TableHead>
              {canWrite && <TableHead></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rules.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium capitalize">{r.packaging_unit}</TableCell>
                <TableCell className="text-right">
                  {num(Number(r.conversion_factor))} {r.base_unit}
                </TableCell>
                <TableCell>
                  <Badge variant={r.active ? "secondary" : "outline"}>
                    {r.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                {canWrite && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggleActive.mutate(r)}>
                        {r.active ? "Deactivate" : "Activate"}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(r)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {(rules.data ?? []).length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={canWrite ? 4 : 3}
                  className="text-center text-muted-foreground py-6"
                >
                  No packaging rules yet — production records this quantity in {product.unit} only.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {canWrite && (
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 border-t pt-4">
            <div>
              <Label>Packaging unit</Label>
              <Input
                value={packagingUnit}
                onChange={(e) => setPackagingUnit(e.target.value)}
                placeholder="e.g. carton"
              />
            </div>
            <div>
              <Label>{product.unit} per unit</Label>
              <MoneyInput
                min={0.0001}
                step="0.0001"
                value={conversionFactor === "" ? 0 : conversionFactor}
                onChange={(v) => setConversionFactor(v === 0 ? "" : v)}
              />
            </div>
            <Button
              size="sm"
              disabled={add.isPending}
              onClick={() => add.mutate()}
              className="gap-1"
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Close
        </Button>
      </DialogFooter>

      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={remove.isPending}
        title={
          deleteTarget ? `Request deletion — ${deleteTarget.packaging_unit}` : "Request deletion"
        }
        onConfirm={(reason) => deleteTarget && remove.mutate({ id: deleteTarget.id, reason })}
      />
    </DialogContent>
  );
}
