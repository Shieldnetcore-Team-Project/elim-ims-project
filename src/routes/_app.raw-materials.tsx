import { createFileRoute } from "@tanstack/react-router";
import { useAutofillUserName } from "@/lib/use-current-user";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
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
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { money, num } from "@/lib/format";
import { isLowStock } from "@/lib/metrics";
import { toast } from "sonner";
import {
  Plus,
  PackagePlus,
  PackageMinus,
  RefreshCw,
  SlidersHorizontal,
  Printer,
  Pencil,
  History,
  Boxes,
  AlertTriangle,
  Wallet,
  Send,
  Ban,
  Undo2,
  ShoppingCart,
  Check,
  X,
  Search,
  Eye,
} from "lucide-react";
import { ReportActions } from "@/components/shared/report-actions";
import { generateStockCardPdf } from "@/lib/pdf";
import {
  useUnitsOfMeasure,
  UNIT_OPTIONS as UNIT_OPTIONS_FALLBACK,
  getUnitOptionsForCategory,
} from "@/lib/units";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { ADJUSTMENT_REASONS } from "@/lib/adjustment-reasons";
import { MaterialCombobox } from "@/components/shared/material-picker";
import {
  BagQty,
  BagQuantityInput,
  BagSizeSetup,
  CostPerBagInput,
  PackOrPiecesInput,
  PreformGrams,
  isPreform,
} from "@/components/shared/bag-quantity";
import { SupplierPicker } from "@/components/shared/supplier-picker";
import { BrandPicker, brandDetail, useBrands } from "@/components/shared/brand-picker";
import { format } from "date-fns";
import { detectPack, formatBags, packPlural, packWord, splitBags } from "@/lib/preform-units";

export const Route = createFileRoute("/_app/raw-materials")({
  head: () => ({
    meta: [{ title: "Raw Materials — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Store" />
      <RequireAccess module="raw-materials">
        <RawMaterialsPage />
      </RequireAccess>
    </>
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
  current_value: number;
  reorder_level: number | null;
  minimum_stock: number | null;
  active: boolean;
  approval_status: string;
  created_by: string | null;
  remarks: string | null;
  supplier_id: string | null;
  suppliers: { name: string } | null;
  material_categories: { name: string } | null;
  pieces_per_bag: number | null;
  grams_per_piece: number | null;
  created_at: string;
  brand_id: string | null;
  brands: { name: string; category: string; grammage: string | null } | null;
};

// What one pack of a material is: its brand's pack (Bag, Carton, Roll) when it
// has one, else read from its name / unit.
const materialPack = (m: Pick<Material, "name" | "unit" | "brands">) =>
  detectPack(m.brands?.category) ?? packWord(m.name, m.unit);
type CostHistoryRow = {
  id: string;
  cost: number;
  previous_cost: number | null;
  effective_date: string;
};
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
  raw_materials: { name: string; unit: string; pieces_per_bag: number | null } | null;
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
  raw_materials: { name: string; unit: string; pieces_per_bag: number | null } | null;
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
  // Restocks straight into stock, no approval (same rule as ReceiveDialog).
  const restocks = confirmReceipt_ || submitMaterial || write;
  const rejectReceipt_ = canReject("goods-receiving");
  const cancelReceipt_ = canCancel("goods-receiving");
  useRealtimeInvalidate(
    [
      "raw_materials",
      "material_categories",
      "suppliers",
      "stock_adjustment_requests",
      "goods_receipts",
      "damage_records",
      "raw_material_movements",
      "raw_material_cost_history",
    ],
    [
      ["raw-materials-list"],
      ["material-categories"],
      ["suppliers-brief"],
      ["stock-adjustment-requests"],
      ["goods-receipts"],
      ["damage-records-raw-materials"],
      ["damage-value-raw-materials"],
      ["material-movements"],
      ["material-cost-history"],
    ],
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<Material | null>(null);
  const [issueTarget, setIssueTarget] = useState<Material | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<Material | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Material | null>(null);
  const [viewTarget, setViewTarget] = useState<Material | null>(null);
  const [purchaseTarget, setPurchaseTarget] = useState<Material | null>(null);
  const [q, setQ] = useState("");

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

  const list = useQuery({
    queryKey: ["raw-materials-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select(
          "id,name,category,category_id,unit,opening_stock,current_stock,unit_cost,current_value,reorder_level,minimum_stock,active,approval_status,created_by,created_at,remarks,supplier_id,brand_id,pieces_per_bag,grams_per_piece,suppliers(name),material_categories(name),brands(name,category,grammage)",
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
          "id,reference_number,material_id,quantity_delta,reason,submitted_by,submitted_at,status,raw_materials(name,unit,pieces_per_bag)",
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
          "id,receipt_number,material_id,quantity,damaged_quantity,accepted_quantity,status,submitted_by,submitted_at,raw_materials(name,unit,pieces_per_bag)",
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
          "id,reference_number,source_type,source_reference,quantity,unit,unit_cost,reason,created_at,raw_materials(name)",
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
        unit_cost: number | null;
        reason: string | null;
        created_at: string;
        raw_materials: { name: string } | null;
      }[];
    },
  });

  // Separate from recentDamage (capped at 20 rows for display) so the
  // "Damaged Value" total below reflects every damage record, not just the
  // most recent page of them.
  const damageValue = useQuery({
    queryKey: ["damage-value-raw-materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("damage_records")
        .select("quantity,unit_cost")
        .eq("factory_id", factoryId!)
        .not("material_id", "is", null);
      if (error) throw error;
      return (data ?? []).reduce((s, d) => s + Number(d.quantity) * Number(d.unit_cost ?? 0), 0);
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
    qc.invalidateQueries({ queryKey: ["material-movements"] });
    qc.invalidateQueries({ queryKey: ["stock-adjustment-requests"] });
    qc.invalidateQueries({ queryKey: ["goods-receipts"] });
    qc.invalidateQueries({ queryKey: ["damage-records-raw-materials"] });
    qc.invalidateQueries({ queryKey: ["damage-value-raw-materials"] });
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

  // Cards cover active materials only (pending-approval / deactivated ones are
  // listed below but hold no usable stock) — the same set the Dashboard and
  // Inventory Overview use.
  const activeMaterials = (list.data ?? []).filter((m) => m.active);
  const summary = {
    totalValue: activeMaterials.reduce((s, m) => s + Number(m.current_value), 0),
    lowStock: activeMaterials.filter((m) => isLowStock(m.current_stock, m.reorder_level)).length,
    totalMaterials: activeMaterials.length,
  };

  // Narrows which rows the Materials table shows — doesn't touch the summary
  // cards above, which stay scoped to all active materials.
  const searchedMaterials = (list.data ?? []).filter((m) => {
    const query = q.trim().toLowerCase();
    if (!query) return true;
    return (
      m.name.toLowerCase().includes(query) ||
      (m.material_categories?.name ?? m.category ?? "").toLowerCase().includes(query) ||
      (m.suppliers?.name ?? "").toLowerCase().includes(query) ||
      (brandDetail(m.brands) ?? "").toLowerCase().includes(query)
    );
  });

  // Who added each material. Ones brought over from the old system have none.
  const creatorIds = [
    ...new Set((list.data ?? []).flatMap((m) => (m.created_by ? [m.created_by] : []))),
  ];
  const creators = useQuery({
    queryKey: ["material-creators", creatorIds],
    enabled: creatorIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id,full_name").in("id", creatorIds);
      return new Map((data ?? []).map((p) => [p.id, p.full_name ?? ""]));
    },
  });
  const createdBy = (m: Material) => (m.created_by ? creators.data?.get(m.created_by) || "—" : "—");

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
        name: settings.data?.company_name ?? "Elim Table Water",
        address: settings.data?.address,
        phone: settings.data?.phone,
        logo_url: settings.data?.logo_url,
      },
      title: "Raw Material Card",
      item_name: m.name,
      unit: m.unit,
      current_stock: Number(m.current_stock),
      unit_cost: Number(m.unit_cost),
      total_value: Number(m.current_value),
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
          <h1 className="text-2xl font-semibold tracking-tight">Store — Raw Materials</h1>
          <p className="text-sm text-muted-foreground">
            Every raw material is stocked here: receive and enter stock, accept QC-passed
            deliveries, issue to Production, and watch reorder alerts.
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
            {formOpen && factoryId && !editing && (
              <AddOrReceiveMaterial
                factoryId={factoryId}
                materials={(list.data ?? []).filter((m) => m.active)}
                suppliers={suppliers.data ?? []}
                categories={materialCategories.data ?? []}
                onDone={() => {
                  setFormOpen(false);
                  invalidateAll();
                  qc.invalidateQueries({ queryKey: ["material-categories"] });
                }}
              />
            )}
            {formOpen && factoryId && editing && (
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard icon={Boxes} label="Total Materials" value={String(summary.totalMaterials)} />
        <SummaryCard icon={Wallet} label="Inventory Value" value={money(summary.totalValue)} />
        <SummaryCard
          icon={AlertTriangle}
          label="Low Stock / Reorder Alerts"
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
          <CardTitle>Materials</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <ReportActions
              size="sm"
              title="Store — Raw Materials"
              fileName="store-raw-materials"
              columns={[
                { key: "sn", label: "S/N" },
                { key: "name", label: "Name" },
                { key: "brand", label: "Brand" },
                { key: "pack", label: "Pack" },
                { key: "grammage", label: "Grammage" },
                { key: "category", label: "Category" },
                { key: "dealer", label: "Dealer" },
                { key: "stock", label: "Current Stock" },
                { key: "packs", label: "In packs" },
                { key: "value", label: "Total Value" },
                { key: "reorder", label: "Reorder Level" },
                { key: "by", label: "Created By" },
                { key: "on", label: "On" },
              ]}
              rows={searchedMaterials.map((m, i) => {
                const split = splitBags(Number(m.current_stock), m.pieces_per_bag);
                return {
                  sn: i + 1,
                  name: m.name,
                  brand: m.brands?.name ?? "",
                  pack: m.brands?.category ?? "",
                  grammage: m.brands?.grammage ?? "",
                  category: m.material_categories?.name ?? m.category ?? "",
                  dealer: m.suppliers?.name ?? "",
                  stock: `${num(Number(m.current_stock))} ${m.unit}`,
                  packs: split ? formatBags(split, materialPack(m)) : "",
                  value: money(Number(m.current_value)),
                  reorder: num(Number(m.reorder_level ?? 0)),
                  by: createdBy(m),
                  on: format(new Date(m.created_at), "dd-MM-yyyy HH:mm:ss"),
                };
              })}
              subtitle={q.trim() ? [`Search: ${q.trim()}`] : []}
            />
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search material, brand, supplier…"
                className="pl-8 h-9 w-56"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>Pack</TableHead>
                <TableHead>Grammage</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Dealer</TableHead>
                <TableHead className="text-right">Current Stock</TableHead>
                <TableHead className="text-right">Total Value</TableHead>
                <TableHead>Reorder Level</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead>On</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {searchedMaterials.map((m, i) => {
                const low = isLowStock(m.current_stock, m.reorder_level);
                return (
                  <TableRow key={m.id}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
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
                    <TableCell>{m.brands?.name ?? "—"}</TableCell>
                    <TableCell>{m.brands?.category ?? "—"}</TableCell>
                    <TableCell>{m.brands?.grammage ?? "—"}</TableCell>
                    <TableCell>{m.material_categories?.name ?? m.category ?? "—"}</TableCell>
                    <TableCell>{m.suppliers?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <BagQty
                        value={Number(m.current_stock)}
                        unit={m.unit}
                        perBag={m.pieces_per_bag}
                        pack={materialPack(m)}
                        bagsFirst
                        className={low ? "text-destructive font-medium" : ""}
                      />
                      {low && (
                        <Badge variant="destructive" className="ml-2">
                          Low
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {money(Number(m.current_value))}
                    </TableCell>
                    <TableCell>
                      <BagQty
                        value={Number(m.reorder_level ?? 0)}
                        unit={m.unit}
                        perBag={m.pieces_per_bag}
                        pack={materialPack(m)}
                      />
                    </TableCell>
                    <TableCell>{createdBy(m)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {format(new Date(m.created_at), "dd-MM-yyyy HH:mm:ss")}
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
                              title={
                                restocks
                                  ? "Restock — goods supplied by a supplier"
                                  : "Submit Goods Receipt"
                              }
                              onClick={() => setReceiveTarget(m)}
                            >
                              {restocks ? (
                                <RefreshCw className="h-4 w-4 text-success" />
                              ) : (
                                <PackagePlus className="h-4 w-4 text-success" />
                              )}
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
                              title="History"
                              onClick={() => setHistoryTarget(m)}
                            >
                              <History className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="View — everything received and released"
                              onClick={() => setViewTarget(m)}
                            >
                              <Eye className="h-4 w-4" />
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
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {searchedMaterials.length === 0 && (
                <TableRow>
                  <TableCell colSpan={14} className="text-center text-muted-foreground py-8">
                    {q.trim() ? "No materials match your search." : "No raw materials yet."}
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
            <CardTitle className="flex items-center gap-2">
              Pending Goods Receipts
              <Badge variant="destructive">{pendingReceipts.data!.length}</Badge>
            </CardTitle>
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
                        <BagQty
                          value={Number(r.quantity)}
                          unit={r.raw_materials?.unit}
                          perBag={r.raw_materials?.pieces_per_bag}
                          pack={packWord(r.raw_materials?.name, r.raw_materials?.unit)}
                        />
                      </TableCell>
                      <TableCell className="text-right text-destructive">
                        {Number(r.damaged_quantity) > 0 ? (
                          <BagQty
                            value={Number(r.damaged_quantity)}
                            unit={r.raw_materials?.unit}
                            perBag={r.raw_materials?.pieces_per_bag}
                            pack={packWord(r.raw_materials?.name, r.raw_materials?.unit)}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <BagQty
                          value={Number(r.accepted_quantity)}
                          unit={r.raw_materials?.unit}
                          perBag={r.raw_materials?.pieces_per_bag}
                          pack={packWord(r.raw_materials?.name, r.raw_materials?.unit)}
                        />
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
            <CardTitle className="flex items-center gap-2">
              Pending Stock Adjustment Requests
              <Badge variant="destructive">{pendingAdjustments.data!.length}</Badge>
            </CardTitle>
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
                        <BagQty
                          value={Number(a.quantity_delta)}
                          unit={a.raw_materials?.unit}
                          perBag={a.raw_materials?.pieces_per_bag}
                          pack={packWord(a.raw_materials?.name, a.raw_materials?.unit)}
                        />
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
                    <TableCell>{d.raw_materials?.name ?? "—"}</TableCell>
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
      <Dialog open={!!viewTarget} onOpenChange={(v) => !v && setViewTarget(null)}>
        {viewTarget && <ReleasesDialog material={viewTarget} />}
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

// "Add Material": first pick the material from everything the store holds.
// An existing one opens the goods receipt for the supplier delivery (so the
// same material is never entered twice); a name that isn’t in the list
// opens the new-material form with that name filled in.
function AddOrReceiveMaterial({
  factoryId,
  materials,
  suppliers,
  categories,
  onDone,
}: {
  factoryId: string;
  materials: Material[];
  suppliers: Supplier[];
  categories: MaterialCategory[];
  onDone: () => void;
}) {
  const [pickedId, setPickedId] = useState("");
  const [newName, setNewName] = useState<string | null>(null);
  const picked = materials.find((m) => m.id === pickedId);
  const back = () => {
    setPickedId("");
    setNewName(null);
  };

  if (newName !== null) {
    return (
      <MaterialForm
        factoryId={factoryId}
        suppliers={suppliers}
        categories={categories}
        editing={null}
        initialName={newName}
        onBack={back}
        onDone={onDone}
      />
    );
  }
  if (picked) {
    return <ReceiveDialog material={picked} suppliers={suppliers} onBack={back} onDone={onDone} />;
  }
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add Material</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="space-y-1.5">
          <Label>Raw material</Label>
          <MaterialCombobox
            value={pickedId}
            materials={materials.map((m) => ({
              id: m.id,
              name: m.name,
              unit: m.unit,
              current_stock: Number(m.current_stock),
              detail: brandDetail(m.brands),
            }))}
            onChange={setPickedId}
            onAddNew={(q) => setNewName(q)}
            addByBrand
          />
          <p className="text-xs text-muted-foreground">
            Open the list and pick the material the supplier delivered to record the quantity
            received. Not on the list? Choose &ldquo;Add new material&rdquo; at the top of the list
            (or type its name first).
          </p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => setNewName("")}>
          <Plus className="mr-1 h-4 w-4" /> New material instead
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function BackToPicker({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="w-fit text-xs text-muted-foreground underline-offset-2 hover:underline"
    >
      &larr; Choose a different material
    </button>
  );
}

function MaterialForm({
  factoryId,
  suppliers,
  categories,
  editing,
  initialName = "",
  onBack,
  onDone,
}: {
  factoryId: string;
  suppliers: Supplier[];
  categories: MaterialCategory[];
  editing: Material | null;
  initialName?: string;
  onBack?: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const unitsOfMeasure = useUnitsOfMeasure();
  const allUnitOptions = unitsOfMeasure.data ?? UNIT_OPTIONS_FALLBACK;
  const [name, setName] = useState(editing?.name ?? initialName);
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
  const [supplierId, setSupplierId] = useState(editing?.supplier_id ?? "none");
  // The brand (Store → Brands): its dealer and pieces per pack fill in below.
  const brands = useBrands(factoryId);
  const [brandId, setBrandId] = useState(editing?.brand_id ?? "none");
  const brand = (brands.data ?? []).find((b) => b.id === brandId);
  const [reorderLevel, setReorderLevel] = useState(
    editing ? Number(editing.reorder_level ?? 0) : 0,
  );
  const [minimumStock, setMinimumStock] = useState(
    editing ? Number(editing.minimum_stock ?? 0) : 0,
  );
  const [remarks, setRemarks] = useState(editing?.remarks ?? "");
  // Pack size for materials delivered in packs but counted in pieces: bags of
  // preforms, cartons of caps, rolls... The pack is read from the name
  // ("Bottle Cap Carton") or the unit chosen. Stock stays in pieces; this
  // only converts.
  const [perBag, setPerBag] = useState<number>(Number(editing?.pieces_per_bag ?? 0));
  const [perBagReason, setPerBagReason] = useState("");
  const detectedPack = detectPack(brand?.category) ?? detectPack(name, unit);
  const pack = detectedPack ?? "bag";
  const showPerBag =
    !!detectedPack || /preform/i.test(name) || !!editing?.pieces_per_bag || perBag > 0;
  // A new material with a pack size is stocked in pieces, whatever unit was picked.
  const pieceUnit = allUnitOptions.find((u) => /^piece/i.test(u)) ?? "pieces";
  const savedUnit = !editing && perBag > 0 ? pieceUnit : unit;
  const perBagChanged =
    !!editing?.pieces_per_bag && perBag > 0 && perBag !== Number(editing.pieces_per_bag);
  // Weight of one preform in grams; shown wherever the preform is picked.
  const [grams, setGrams] = useState<number>(Number(editing?.grams_per_piece ?? 0));
  const [gramsReason, setGramsReason] = useState("");
  const gramsChanged =
    !!editing?.grams_per_piece && grams > 0 && grams !== Number(editing.grams_per_piece);

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

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Material name is required");
      if (!savedUnit.trim()) throw new Error("Select or enter a unit of measurement");
      // No unit cost here: the cost comes in with each delivery (Restock).
      const payload = {
        name: name.trim(),
        category_id: categoryId === "none" ? null : categoryId,
        unit: savedUnit.trim(),
        supplier_id: supplierId === "none" ? null : supplierId,
        brand_id: brandId === "none" ? null : brandId,
        reorder_level: reorderLevel,
        minimum_stock: minimumStock,
        remarks: remarks || null,
      };
      if (perBag && (perBag < 0 || perBag !== Math.floor(perBag)))
        throw new Error(`Pieces per ${pack} must be a whole number`);
      if (perBagChanged && !perBagReason.trim())
        throw new Error(`Give a reason for changing pieces per ${pack}`);
      if (gramsChanged && !gramsReason.trim())
        throw new Error("Give a reason for changing the grams per preform");
      let materialId = editing?.id ?? null;
      if (editing) {
        // The brand goes in only when it changed: until the database grants
        // it (20261023150000), writing brand_id at all is refused.
        const { brand_id, ...rest } = payload;
        const update = brand_id === (editing.brand_id ?? null) ? rest : payload;
        const { error } = await supabase.from("raw_materials").update(update).eq("id", editing.id);
        if (error) throw error;
      } else {
        // New materials still go through the request_new_material RPC (it's
        // the only thing with INSERT privilege on raw_materials — direct
        // client inserts are revoked), but it now creates the material live
        // (approved/active) instead of parking it in pending_approval.
        const { data, error } = await supabase.rpc("request_new_material", {
          payload: { ...payload, factory_id: factoryId, opening_stock: openingStock } as any,
        });
        if (error) throw error;
        materialId = (data as { id?: string } | null)?.id ?? null;
      }
      if (materialId && perBag > 0 && perBag !== Number(editing?.pieces_per_bag ?? 0)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
        const { error } = await (supabase as any).rpc("set_material_pieces_per_bag", {
          p_material: materialId,
          p_pieces_per_bag: perBag,
          p_reason: perBagReason.trim() || null,
        });
        if (error) throw error;
      }
      if (materialId && grams > 0 && grams !== Number(editing?.grams_per_piece ?? 0)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
        const { error } = await (supabase as any).rpc("set_material_grams", {
          p_material: materialId,
          p_grams: grams,
          p_reason: gramsReason.trim() || null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Material updated" : "Material added");
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
        {onBack && <BackToPicker onBack={onBack} />}
        <div>
          <Label>Raw material name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Brand</Label>
          <BrandPicker
            brands={brands.data ?? []}
            value={brandId}
            onChange={(id) => {
              setBrandId(id);
              const b = (brands.data ?? []).find((x) => x.id === id);
              if (!b) return;
              // Fill what the brand already says; anything typed stays.
              if (supplierId === "none" && b.supplier_id) setSupplierId(b.supplier_id);
              if (!perBag && b.pack_quantity > 1) setPerBag(b.pack_quantity);
            }}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Not on the list? Add it on Store → Brands first.
          </p>
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
        {showPerBag && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="capitalize">Pieces per {pack}</Label>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={perBag || ""}
                placeholder={pack === "carton" ? "e.g. 4800" : "e.g. 1152"}
                onChange={(e) =>
                  setPerBag(e.target.value === "" ? 0 : Math.floor(Number(e.target.value)))
                }
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Stock is kept in pieces and also shown in {packPlural(pack)}; deliveries and issues
                can be entered as {packPlural(pack)} + loose pieces.
              </p>
            </div>
            {perBagChanged && (
              <div>
                <Label>Why is the {pack} size changing?</Label>
                <Input
                  value={perBagReason}
                  onChange={(e) => setPerBagReason(e.target.value)}
                  placeholder={`e.g. new supplier ${pack} size`}
                />
              </div>
            )}
            {(isPreform(name) || !!editing?.grams_per_piece) && (
              <div>
                <Label>Weight per preform (grams)</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.1"
                  value={grams || ""}
                  placeholder="e.g. 18"
                  onChange={(e) =>
                    setGrams(e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))
                  }
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Comes along wherever this preform is picked.
                </p>
              </div>
            )}
            {gramsChanged && (
              <div>
                <Label>Why are the grams changing?</Label>
                <Input
                  value={gramsReason}
                  onChange={(e) => setGramsReason(e.target.value)}
                  placeholder="e.g. new mould"
                />
              </div>
            )}
          </div>
        )}
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
        {perBag > 0 ? (
          <BagQuantityInput
            label="Opening stock"
            value={openingStock}
            onChange={setOpeningStock}
            perBag={perBag}
            unit={editing ? editing.unit : pieceUnit}
            pack={pack}
            disabled={!!editing}
          />
        ) : (
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
        )}
        <div>
          <Label>Supplier</Label>
          <SupplierPicker
            factoryId={factoryId}
            suppliers={suppliers}
            value={supplierId}
            onChange={setSupplierId}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Not on the list? Type the name and choose &ldquo;Add as a new supplier&rdquo;.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Minimum stock</Label>
            <MoneyInput min={0} step="0.001" value={minimumStock} onChange={setMinimumStock} />
          </div>
          <div>
            <Label>Reorder level</Label>
            <MoneyInput min={0} step="0.001" value={reorderLevel} onChange={setReorderLevel} />
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
  onBack,
  onDone,
}: {
  material: Material;
  suppliers: Supplier[];
  onBack?: () => void;
  onDone: () => void;
}) {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  // Restocking on the Store page needs no approval: whoever keeps stock here
  // (goods-receiving confirm, or raw-materials submit / create) restocks
  // supplier deliveries straight into stock
  // (20261023120000_store_restock_no_approval.sql). Anyone else (QC) submits
  // the receipt for a different person to confirm.
  const { canConfirm, canSubmit, canCreate } = usePermissions();
  const restock =
    canConfirm("goods-receiving") || canSubmit("raw-materials") || canCreate("raw-materials");
  // One key per dialog: a double click restocks once.
  const [clientRef] = useState(() => crypto.randomUUID());
  // Preforms are received in bags; one with no bag size sets it here first.
  const [perBag, setPerBag] = useState<number | null>(material.pieces_per_bag);
  const needsBagSize = isPreform(material.name) && !perBag;
  const [grams, setGrams] = useState<number | null>(material.grams_per_piece);
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
      const payload = {
        material_id: material.id,
        quantity,
        damaged_quantity: damagedQuantity,
        unit_cost: unitCost,
        supplier_id: supplierId === "none" ? null : supplierId,
        delivery_reference: deliveryReference || null,
        remarks: remarks || null,
      };
      const { error } = restock
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any -- function newer than the generated types
          await (supabase.rpc as any)("restock_raw_material", {
            payload: { ...payload, client_ref: clientRef },
          })
        : await supabase.rpc("submit_goods_receipt", { payload: payload as any });
      if (error) throw error;
    },
    onSuccess: () => {
      if (restock) {
        toast.success("Restocked — stock updated");
        qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
        qc.invalidateQueries({ queryKey: ["goods-receipts"] });
      } else {
        toast.success("Submitted — awaiting confirmation by a different person");
      }
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {restock ? "Restock" : "Submit Goods Receipt"} — {material.name}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        {onBack && <BackToPicker onBack={onBack} />}
        <p className="text-xs text-muted-foreground">
          In store now:{" "}
          <BagQty
            value={Number(material.current_stock)}
            unit={material.unit}
            perBag={perBag}
            pack={materialPack(material)}
            bagsFirst
          />
          {restock
            ? " Enter what the supplier delivered; stock updates as soon as you restock."
            : " Dual control: this only posts to stock once someone else confirms it."}
        </p>
        {needsBagSize && (
          <BagSizeSetup
            materialId={material.id}
            materialName={material.name}
            onSaved={(n) => {
              setPerBag(n);
              qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
            }}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <BagQuantityInput
            label={perBag ? "Bags received" : "Quantity received"}
            value={quantity}
            onChange={setQuantity}
            perBag={perBag}
            pack={materialPack(material)}
            unit={material.unit}
            disabled={needsBagSize}
          />
          <BagQuantityInput
            label={perBag ? "Damaged (bags)" : "Damaged quantity"}
            value={damagedQuantity}
            onChange={setDamagedQuantity}
            perBag={perBag}
            pack={materialPack(material)}
            unit={material.unit}
            disabled={needsBagSize}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Accepted quantity:{" "}
          <BagQty
            value={accepted}
            unit={material.unit}
            perBag={perBag}
            pack={materialPack(material)}
            bagsFirst
          />{" "}
          Only this posts to stock; damaged goes to the damage ledger.
        </p>
        {(isPreform(material.name) || grams) && (
          <PreformGrams
            materialId={material.id}
            materialName={material.name}
            grams={grams}
            pieces={accepted}
            canSet
            onSaved={(g) => {
              setGrams(g);
              qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
            }}
          />
        )}
        <CostPerBagInput
          unitCost={unitCost}
          onChange={setUnitCost}
          perBag={perBag}
          pack={materialPack(material)}
          unit={material.unit}
        />
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
          <SupplierPicker
            factoryId={factoryId}
            suppliers={suppliers}
            value={supplierId}
            onChange={setSupplierId}
          />
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || needsBagSize || quantity <= 0 || damagedQuantity > quantity}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Saving…" : restock ? "Restock" : "Submit for Confirmation"}
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
  useAutofillUserName(requestedByName, setRequestedByName);
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
        <BagQuantityInput
          label="Quantity to request"
          value={quantity}
          onChange={setQuantity}
          perBag={material.pieces_per_bag}
          pack={materialPack(material)}
          unit={material.unit}
        />
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

type IssueDepartment = "production" | "quality_control";
const ISSUE_DEPARTMENT_LABEL: Record<IssueDepartment, string> = {
  production: "Production Manager",
  quality_control: "Quality Control",
};

function IssueDialog({ material, onDone }: { material: Material; onDone: () => void }) {
  const { data: factoryId } = useFactoryId();
  // People the Store can issue to (issue_recipients, 20261020160000):
  // production managers / production staff and QC officers.
  const recipients = useQuery({
    queryKey: ["issue-recipients", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { data, error } = await (supabase as any).rpc("issue_recipients", {
        p_factory: factoryId,
      });
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string; department: IssueDepartment }[];
    },
  });
  // "<department>:<user id>", or "<department>:" for the department only.
  const [issueTo, setIssueTo] = useState("");
  const [toDept, toUser] = issueTo.split(":") as [IssueDepartment | "", string | undefined];
  const [quantity, setQuantity] = useState(0);
  // Preforms are issued in bags; one with no bag size sets it here first.
  const [perBag, setPerBag] = useState<number | null>(material.pieces_per_bag);
  const needsBagSize = isPreform(material.name) && !perBag;
  const [purpose, setPurpose] = useState<"production" | "general">("production");
  const pickIssueTo = (v: string) => {
    setIssueTo(v);
    // QC takes stock for testing, not for production use.
    setPurpose(v.startsWith("quality_control") ? "general" : "production");
  };
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      if (!toDept) throw new Error("Pick who the stock is issued to");
      const { error } = await supabase.rpc("issue_raw_material", {
        payload: {
          material_id: material.id,
          quantity,
          purpose,
          issued_to_department: toDept,
          issued_to_user: toUser || null,
          reason: reason || null,
          reference: reference || null,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Issued to ${toDept ? ISSUE_DEPARTMENT_LABEL[toDept] : "—"}`);
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
          Available:{" "}
          <BagQty
            value={Number(material.current_stock)}
            unit={material.unit}
            perBag={perBag}
            pack={materialPack(material)}
          />
        </p>
        <div>
          <Label>Issue to</Label>
          <Select value={issueTo} onValueChange={pickIssueTo}>
            <SelectTrigger>
              <SelectValue placeholder="Who receives the stock?" />
            </SelectTrigger>
            <SelectContent>
              {(["production", "quality_control"] as IssueDepartment[]).map((d) => {
                const people = (recipients.data ?? []).filter((r) => r.department === d);
                return (
                  <SelectGroup key={d}>
                    <SelectLabel>{ISSUE_DEPARTMENT_LABEL[d]}</SelectLabel>
                    {people.map((p) => (
                      <SelectItem key={p.id} value={`${d}:${p.id}`}>
                        {p.full_name}
                      </SelectItem>
                    ))}
                    <SelectItem value={`${d}:`}>
                      {ISSUE_DEPARTMENT_LABEL[d]} (department)
                    </SelectItem>
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        </div>
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
        {needsBagSize && (
          <BagSizeSetup
            materialId={material.id}
            materialName={material.name}
            onSaved={(n) => setPerBag(n)}
          />
        )}
        {/* Entered in bags (or pieces); issued and kept in pieces. */}
        <PackOrPiecesInput
          label="Quantity issued"
          value={quantity}
          onChange={setQuantity}
          perBag={perBag}
          pack={materialPack(material)}
          unit={material.unit}
          max={Number(material.current_stock)}
        />
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
          disabled={
            submit.isPending ||
            !toDept ||
            quantity <= 0 ||
            quantity > Number(material.current_stock)
          }
          onClick={() => submit.mutate()}
        >
          {submit.isPending
            ? "Saving…"
            : toDept
              ? `Issue to ${ISSUE_DEPARTMENT_LABEL[toDept]}`
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
      // Store adjustments post at once (20261023130000_store_stock_counts_no_approval.sql).
      toast.success("Stock adjusted");
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
            <BagQty
              value={oldQuantity}
              perBag={material.pieces_per_bag}
              pack={materialPack(material)}
              className="text-xs"
            />
          </div>
          <BagQuantityInput
            label="New quantity"
            value={newQuantity}
            onChange={setNewQuantity}
            perBag={material.pieces_per_bag}
            pack={materialPack(material)}
            unit={material.unit}
          />
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
          The stock changes as soon as you save — no approval needed. It is recorded in the
          material&rsquo;s history with your name and reason.
        </p>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || delta === 0 || !reason}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Saving…" : "Adjust stock"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// View: the material's stock card as the Store reads it -- every movement with
// the balance before it (Opening), what came in, the total, what went out,
// who collected it and for which department, and the balance after.
type ReleaseRow = Movement & {
  issued_to_department: string | null;
  issued_to_user: string | null;
};

const MOVEMENT_LABEL: Record<string, string> = {
  received: "Received",
  opening_balance: "Opening balance",
  adjusted: "Adjustment",
  correction: "Correction",
  issued: "Issued",
  used_for_production: "Production",
  return_from_production: "Returned by Production",
  returned: "Returned",
  damaged: "Damaged",
  expiry: "Expired",
  transferred: "Transferred",
};

function ReleasesDialog({ material }: { material: Material }) {
  const [day, setDay] = useState("");
  const title = `All Materials Released For ${material.name}${
    material.brands ? ` (${brandDetail(material.brands)})` : ""
  }`;

  const movements = useQuery({
    queryKey: ["material-releases", material.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_material_movements")
        .select(
          "id,movement_type,quantity,unit_cost,reference,reason,user_id,created_at,quantity_before,quantity_after,issued_to_department,issued_to_user",
        )
        .eq("material_id", material.id)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as ReleaseRow[];
    },
  });

  const collectorIds = [
    ...new Set((movements.data ?? []).flatMap((r) => (r.issued_to_user ? [r.issued_to_user] : []))),
  ];
  const collectors = useQuery({
    queryKey: ["release-collectors", collectorIds],
    enabled: collectorIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", collectorIds);
      return new Map((data ?? []).map((p) => [p.id, p.full_name ?? ""]));
    },
  });

  const rows = (movements.data ?? [])
    .filter((r) => !day || format(new Date(r.created_at), "yyyy-MM-dd") === day)
    .map((r) => {
      // In / out from the balance before and after; older rows without them
      // fall back to the movement's direction.
      const before = r.quantity_before == null ? null : Number(r.quantity_before);
      const after = r.quantity_after == null ? null : Number(r.quantity_after);
      const out = /^(issued|used_for_production|damaged|expiry|transferred)$/.test(r.movement_type);
      const delta =
        before != null && after != null
          ? after - before
          : out
            ? -Math.abs(Number(r.quantity))
            : Math.abs(Number(r.quantity));
      const qtyIn = Math.max(delta, 0);
      const qtyOut = Math.max(-delta, 0);
      const dept = r.issued_to_department
        ? (ISSUE_DEPARTMENT_LABEL[r.issued_to_department as IssueDepartment] ??
          r.issued_to_department)
        : (MOVEMENT_LABEL[r.movement_type] ?? r.movement_type.replace(/_/g, " "));
      return {
        id: r.id,
        opening: before,
        qtyIn,
        total: before == null ? null : before + qtyIn,
        out: qtyOut,
        collectedBy: r.issued_to_user ? collectors.data?.get(r.issued_to_user) || "—" : "—",
        dept,
        balance: after,
        when: format(new Date(r.created_at), "dd-MM-yyyy HH:mm:ss"),
      };
    });

  const qty = (n: number | null) => (n == null ? "—" : num(n));

  return (
    <DialogContent className="max-w-5xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <p className="text-sm text-muted-foreground">
          List of all items received and released for {material.name}, in {material.unit}.
        </p>
      </DialogHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions
          size="sm"
          title={title}
          fileName={`releases-${material.name.toLowerCase().replace(/\s+/g, "-")}`}
          columns={[
            { key: "sn", label: "S/N" },
            { key: "opening", label: "Opening" },
            { key: "qtyIn", label: "Qty In" },
            { key: "total", label: "Total" },
            { key: "out", label: "Out" },
            { key: "collectedBy", label: "Collected By" },
            { key: "dept", label: "Dept." },
            { key: "balance", label: "Balance" },
            { key: "when", label: "Date/Time" },
          ]}
          rows={rows.map((r, i) => ({
            sn: i + 1,
            opening: qty(r.opening),
            qtyIn: num(r.qtyIn),
            total: qty(r.total),
            out: num(r.out),
            collectedBy: r.collectedBy,
            dept: r.dept,
            balance: qty(r.balance),
            when: r.when,
          }))}
          subtitle={[`Unit: ${material.unit}`, ...(day ? [`Date: ${day}`] : [])]}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="release-day" className="whitespace-nowrap">
            Filter by date
          </Label>
          <Input
            id="release-day"
            type="date"
            className="h-9 w-44"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
          {day && (
            <Button variant="ghost" size="sm" onClick={() => setDay("")}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <div className="max-h-[65vh] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">S/N</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Qty In</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead>Collected By</TableHead>
              <TableHead>Dept.</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Date/Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                <TableCell className="text-right">{qty(r.opening)}</TableCell>
                <TableCell className="text-right">{num(r.qtyIn)}</TableCell>
                <TableCell className="text-right">{qty(r.total)}</TableCell>
                <TableCell className="text-right">{num(r.out)}</TableCell>
                <TableCell>{r.collectedBy}</TableCell>
                <TableCell>{r.dept}</TableCell>
                <TableCell className="text-right font-medium">{qty(r.balance)}</TableCell>
                <TableCell className="whitespace-nowrap">{r.when}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                  {movements.isLoading
                    ? "Loading…"
                    : day
                      ? "Nothing received or released on this date."
                      : "Nothing received or released yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
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

  const costHistory = useQuery({
    queryKey: ["material-cost-history", material.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_material_cost_history")
        .select("id,cost,previous_cost,effective_date")
        .eq("material_id", material.id)
        .order("effective_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CostHistoryRow[];
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
        <DialogTitle>History — {material.name}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        <div>
          <div className="mb-2 text-sm font-medium">Stock movements</div>
          <p className="mb-2 text-xs text-muted-foreground">
            Unit cost and value below are each transaction's own recorded cost at the time it
            happened — not the material's current unit cost.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date &amp; Time</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Before</TableHead>
                <TableHead className="text-right">After</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
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
                    <BagQty
                      value={Number(m.quantity)}
                      unit={material.unit}
                      perBag={material.pieces_per_bag}
                      pack={materialPack(material)}
                    />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-xs">
                    {m.quantity_before === null
                      ? "—"
                      : `${num(m.quantity_before)} ${material.unit}`}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {m.quantity_after === null ? "—" : `${num(m.quantity_after)} ${material.unit}`}
                  </TableCell>
                  <TableCell className="text-right">
                    {m.unit_cost == null ? "—" : money(Number(m.unit_cost))}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {m.unit_cost == null ? "—" : money(Number(m.quantity) * Number(m.unit_cost))}
                  </TableCell>
                  <TableCell>{m.reference ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{m.reason ?? "—"}</TableCell>
                </TableRow>
              ))}
              {(movements.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                    No movements yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Unit cost history</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Effective</TableHead>
                <TableHead className="text-right">Previous cost</TableHead>
                <TableHead className="text-right">New cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(costHistory.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{new Date(c.effective_date).toLocaleString()}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {c.previous_cost == null ? "—" : money(Number(c.previous_cost))}
                  </TableCell>
                  <TableCell className="text-right font-medium">{money(Number(c.cost))}</TableCell>
                </TableRow>
              ))}
              {(costHistory.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                    No unit cost changes recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </DialogContent>
  );
}
