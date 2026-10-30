import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { usePermissions } from "@/lib/permissions";
import { useFactoryId } from "@/lib/use-factory";
import { logAudit } from "@/lib/audit";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Truck,
  Plus,
  Wrench,
  Pencil,
  Trash2,
  Check,
  X,
  ShoppingCart,
  CircleCheck,
  Ban,
  Eye,
  Package,
  ClipboardList,
  ArrowLeftRight,
  ShieldCheck,
} from "lucide-react";
import { requestDelete } from "@/lib/request-delete";
import { num } from "@/lib/format";
import { PartsInventoryTab, StockMovementsTab } from "@/components/maintenance/parts-inventory";
import { MaintenanceLogTab } from "@/components/maintenance/maintenance-log";
import { IssueApprovalsTab } from "@/components/maintenance/issue-approvals";
import {
  db,
  isLowStock,
  MAINTENANCE_QUERY_KEYS,
  useMaintenanceLogs,
  useMaintenanceMovements,
  useMaintenanceParts,
  useMaintenanceIssues,
} from "@/components/maintenance/shared";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";
import { RefId } from "@/components/shared/ref-id";
import { SearchBox } from "@/components/shared/search-box";
import { matchesSearch, useSearchQuery } from "@/lib/search";

export const Route = createFileRoute("/_app/maintenance")({
  head: () => ({ meta: [{ title: "Maintenance — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="logistics">
      <MaintenancePage />
    </RequireAccess>
  ),
});

const CATEGORY_LABELS: Record<string, string> = {
  machine_purchase: "Machine purchase",
  machine_parts: "Machine parts",
  vehicle_repair: "Vehicle repair / maintenance",
  factory_maintenance: "Factory maintenance",
  other: "Other",
};

const STATUS_LABELS: Record<string, string> = {
  pending_approval: "Pending approval",
  approved: "Approved — in progress",
  rejected: "Rejected",
  completed: "Completed",
  cancelled: "Cancelled",
};

const statusVariant = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "completed"
    ? "secondary"
    : s === "rejected" || s === "cancelled"
      ? "destructive"
      : s === "approved"
        ? "default"
        : "outline";

const priorityVariant = (p: string): "default" | "secondary" | "outline" | "destructive" =>
  p === "urgent" ? "destructive" : p === "high" ? "default" : "outline";

type RequestRow = {
  id: string;
  request_number: string;
  category: string;
  title: string;
  description: string | null;
  vehicle_id: string | null;
  asset_name: string | null;
  priority: string;
  estimated_cost: number | null;
  status: string;
  requested_by: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  completion_notes: string | null;
  created_at: string;
  vehicles: { plate_number: string } | null;
};

type PurchaseRow = {
  id: string;
  request_id: string;
  purchase_date: string;
  item_description: string;
  quantity: number;
  unit_cost: number;
  amount: number;
  vendor: string | null;
  receipt_ref: string | null;
  notes: string | null;
  recorded_by_name: string | null;
};

type VehicleRow = {
  id: string;
  plate_number: string;
  brand: string | null;
  model: string | null;
  vehicle_type: string | null;
  year: number | null;
  color: string | null;
  capacity: string | null;
  chassis_number: string | null;
  engine_number: string | null;
  registration_expiry_date: string | null;
  insurance_expiry_date: string | null;
  status: string;
};

const emptyVehicleForm = {
  plate_number: "",
  brand: "",
  model: "",
  vehicle_type: "",
  year: "",
  color: "",
  capacity: "",
  chassis_number: "",
  engine_number: "",
  registration_expiry_date: "",
  insurance_expiry_date: "",
  status: "active",
};

const emptyRequestForm = {
  category: "",
  title: "",
  description: "",
  vehicle_id: "",
  asset_name: "",
  priority: "normal",
  estimated_cost: "",
};

const emptyPurchaseForm = () => ({
  purchase_date: new Date().toISOString().slice(0, 10),
  part_id: "",
  item_description: "",
  quantity: "1",
  unit_cost: "",
  vendor: "",
  receipt_ref: "",
  notes: "",
});

function MaintenancePage() {
  // Another user's receipt, issue or approval shows here without a refresh.
  useRealtimeInvalidate(
    [
      "maintenance_parts",
      "maintenance_stock_movements",
      "maintenance_issue_requests",
      "maintenance_logs",
      "maintenance_requests",
      "maintenance_purchases",
      "vehicles",
    ],
    [
      ["maintenance-parts"],
      ["maintenance-movements"],
      ["maintenance-issues"],
      ["maintenance-logs"],
      ["maintenance-requests"],
      ["maintenance-purchases"],
      ["logistics-vehicles"],
    ],
  );
  const [q, setQ] = useSearchQuery();
  const qc = useQueryClient();
  const { canWrite, canEdit, canApprove, canReject, canCancel } = usePermissions();
  const factory = useFactoryId();
  const factoryId = factory.data;
  const write = canWrite("logistics");

  const [statusFilter, setStatusFilter] = useState("all");
  const [requestOpen, setRequestOpen] = useState(false);
  const [rForm, setRForm] = useState(emptyRequestForm);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [pForm, setPForm] = useState(emptyPurchaseForm);
  // One dialog for every "needs a note" action on a request.
  const [noteAction, setNoteAction] = useState<"approve" | "reject" | "complete" | "cancel" | null>(
    null,
  );
  const [note, setNote] = useState("");

  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<VehicleRow | null>(null);
  const [deleteVehicleTarget, setDeleteVehicleTarget] = useState<VehicleRow | null>(null);
  const [vForm, setVForm] = useState(emptyVehicleForm);

  const { data: me } = useQuery({
    queryKey: ["auth-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });

  const requests = useQuery({
    queryKey: ["maintenance-requests", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_requests")
        .select("*, vehicles(plate_number)")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as RequestRow[];
    },
  });

  const purchases = useQuery({
    queryKey: ["maintenance-purchases", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_purchases")
        .select("*")
        .eq("factory_id", factoryId!)
        .order("purchase_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PurchaseRow[];
    },
  });

  const vehicles = useQuery({
    queryKey: ["logistics-vehicles", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vehicles")
        .select("*")
        .eq("factory_id", factoryId!)
        .order("plate_number");
      if (error) throw error;
      return data ?? [];
    },
  });

  const parts = useMaintenanceParts(factoryId);
  const movements = useMaintenanceMovements(factoryId);
  const logs = useMaintenanceLogs(factoryId);
  const issues = useMaintenanceIssues(factoryId);
  const pendingIssueCount = (issues.data ?? []).filter(
    (i) => i.status === "pending_approval",
  ).length;

  const spentByRequest = new Map<string, number>();
  for (const p of purchases.data ?? []) {
    spentByRequest.set(p.request_id, (spentByRequest.get(p.request_id) ?? 0) + Number(p.amount));
  }

  const allRequests = requests.data ?? [];
  const viewing = allRequests.find((r) => r.id === viewingId) ?? null;
  const viewingPurchases = (purchases.data ?? []).filter((p) => p.request_id === viewingId);
  const visibleRequests = allRequests
    .filter((r) => statusFilter === "all" || r.status === statusFilter)
    .filter((r) => matchesSearch(q, r));

  const pendingCount = allRequests.filter((r) => r.status === "pending_approval").length;
  const lowStockCount = (parts.data ?? []).filter((p) => p.is_active && isLowStock(p)).length;
  const stockValue = (parts.data ?? []).reduce(
    (s, p) => s + Number(p.quantity_on_hand) * Number(p.last_unit_cost ?? 0),
    0,
  );
  // Money out this month: request purchases, parts bought straight into stock
  // (a request purchase that names a part also writes a stock row — counted
  // once, via purchase_id), and labour/other costs on the maintenance log.
  const monthStart = new Date().toISOString().slice(0, 8) + "01";
  const spentThisMonth =
    (purchases.data ?? [])
      .filter((p) => p.purchase_date >= monthStart)
      .reduce((s, p) => s + Number(p.amount), 0) +
    (movements.data ?? [])
      .filter(
        (m) => m.movement_type === "purchased" && !m.purchase_id && m.movement_date >= monthStart,
      )
      .reduce((s, m) => s + Number(m.quantity) * Number(m.unit_cost ?? 0), 0) +
    (logs.data ?? [])
      .filter((l) => l.service_date >= monthStart)
      .reduce((s, l) => s + Number(l.labour_cost) + Number(l.other_cost), 0);

  const invalidateMaintenance = () =>
    MAINTENANCE_QUERY_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey }));

  const createRequest = useMutation({
    mutationFn: async () => {
      const { data, error } = await db.rpc("create_maintenance_request", {
        payload: {
          factory_id: factoryId,
          category: rForm.category,
          title: rForm.title,
          description: rForm.description || null,
          vehicle_id: rForm.vehicle_id || null,
          asset_name: rForm.asset_name || null,
          priority: rForm.priority,
          estimated_cost: rForm.estimated_cost === "" ? null : Number(rForm.estimated_cost),
        },
      });
      if (error) throw error;
      return data as { id: string; request_number: string };
    },
    onSuccess: (res) => {
      toast.success(`Request ${res.request_number} sent for approval`);
      logAudit({
        action: "create",
        entity: "maintenance_requests",
        entityId: res.id,
        factoryId,
      });
      invalidateMaintenance();
      setRequestOpen(false);
      setRForm(emptyRequestForm);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runNoteAction = useMutation({
    mutationFn: async () => {
      if (!viewing || !noteAction) throw new Error("No request selected");
      const call =
        noteAction === "approve" || noteAction === "reject"
          ? db.rpc("decide_maintenance_request", {
              p_id: viewing.id,
              p_approve: noteAction === "approve",
              p_note: note || null,
            })
          : noteAction === "complete"
            ? db.rpc("complete_maintenance_request", { p_id: viewing.id, p_notes: note || null })
            : db.rpc("cancel_maintenance_request", { p_id: viewing.id, p_reason: note });
      const { error } = await call;
      if (error) throw error;
    },
    onSuccess: () => {
      const done = {
        approve: "Request approved",
        reject: "Request rejected",
        complete: "Request marked completed",
        cancel: "Request cancelled",
      }[noteAction!];
      toast.success(done);
      logAudit({
        action: "update",
        entity: "maintenance_requests",
        entityId: viewing?.id,
        factoryId,
        newValue: { action: noteAction, note: note || null },
      });
      invalidateMaintenance();
      setNoteAction(null);
      setNote("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addPurchase = useMutation({
    mutationFn: async () => {
      if (!viewing) throw new Error("No request selected");
      const { error } = await db.rpc("add_maintenance_purchase", {
        payload: {
          request_id: viewing.id,
          purchase_date: pForm.purchase_date,
          part_id: pForm.part_id || null,
          item_description: pForm.item_description,
          quantity: Number(pForm.quantity),
          unit_cost: Number(pForm.unit_cost),
          vendor: pForm.vendor || null,
          receipt_ref: pForm.receipt_ref || null,
          notes: pForm.notes || null,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Purchase logged");
      logAudit({
        action: "create",
        entity: "maintenance_purchases",
        entityId: viewing?.id,
        factoryId,
      });
      invalidateMaintenance();
      setPurchaseOpen(false);
      setPForm(emptyPurchaseForm());
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetVehicleForm = () => {
    setEditingVehicle(null);
    setVForm(emptyVehicleForm);
  };

  const vehiclePayload = () => ({
    plate_number: vForm.plate_number,
    brand: vForm.brand || null,
    model: vForm.model || null,
    vehicle_type: vForm.vehicle_type || null,
    year: vForm.year === "" ? null : Number(vForm.year),
    color: vForm.color || null,
    capacity: vForm.capacity || null,
    chassis_number: vForm.chassis_number || null,
    engine_number: vForm.engine_number || null,
    registration_expiry_date: vForm.registration_expiry_date || null,
    insurance_expiry_date: vForm.insurance_expiry_date || null,
    status: vForm.status,
  });

  const addVehicle = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("vehicles")
        .insert({ factory_id: factoryId!, ...vehiclePayload() });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Vehicle added");
      logAudit({ action: "create", entity: "vehicles", factoryId });
      qc.invalidateQueries({ queryKey: ["logistics-vehicles"] });
      setVehicleOpen(false);
      resetVehicleForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateVehicle = useMutation({
    mutationFn: async () => {
      if (!editingVehicle) throw new Error("No vehicle selected");
      const { error } = await supabase
        .from("vehicles")
        .update(vehiclePayload())
        .eq("id", editingVehicle.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Vehicle updated");
      logAudit({ action: "update", entity: "vehicles", entityId: editingVehicle?.id, factoryId });
      qc.invalidateQueries({ queryKey: ["logistics-vehicles"] });
      setVehicleOpen(false);
      resetVehicleForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteVehicle = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await requestDelete("vehicles", id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteVehicleTarget(null);
      qc.invalidateQueries({ queryKey: ["logistics-vehicles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const viewingSpent = viewing ? (spentByRequest.get(viewing.id) ?? 0) : 0;
  const isOwnRequest = !!viewing && viewing.requested_by === me;
  const canCancelViewing =
    !!viewing &&
    (viewing.status === "pending_approval" || viewing.status === "approved") &&
    viewingPurchases.length === 0 &&
    (canCancel("logistics") || (isOwnRequest && write));

  const noteTitle = {
    approve: "Approve request",
    reject: "Reject request",
    complete: "Mark request completed",
    cancel: "Cancel request",
  };
  const noteRequired = noteAction === "reject" || noteAction === "cancel";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
        <p className="text-sm text-muted-foreground">
          Keep stock of every part and item received or bought for maintenance, log vehicle repairs,
          machine and part repairs and servicing, and send purchase requests for approval.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Parts low on stock
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {num(lowStockCount)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              of {num(parts.data?.length ?? 0)}
            </span>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Stock value</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{money(stockValue)}</CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Awaiting approval
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {pendingIssueCount + pendingCount}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              {pendingIssueCount} issue{pendingIssueCount === 1 ? "" : "s"}, {pendingCount} request
              {pendingCount === 1 ? "" : "s"}
            </span>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Spent this month
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{money(spentThisMonth)}</CardContent>
        </Card>
      </div>

      <Tabs defaultValue="parts">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="parts">
            <Package className="mr-1.5 h-4 w-4" /> Parts Inventory
          </TabsTrigger>
          <TabsTrigger value="log">
            <Wrench className="mr-1.5 h-4 w-4" /> Maintenance Log
          </TabsTrigger>
          <TabsTrigger value="issues">
            <ShieldCheck className="mr-1.5 h-4 w-4" /> Issue Approvals
            {pendingIssueCount > 0 && (
              <Badge variant="destructive" className="ml-1.5 px-1.5 py-0 text-[10px]">
                {pendingIssueCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="movements">
            <ArrowLeftRight className="mr-1.5 h-4 w-4" /> Stock Movements
          </TabsTrigger>
          <TabsTrigger value="requests">
            <ClipboardList className="mr-1.5 h-4 w-4" /> Requests
            {pendingCount > 0 && (
              <Badge variant="destructive" className="ml-1.5 px-1.5 py-0 text-[10px]">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="vehicles">
            <Truck className="mr-1.5 h-4 w-4" /> Vehicles
          </TabsTrigger>
        </TabsList>

        <TabsContent value="parts" className="pt-4">
          <PartsInventoryTab factoryId={factoryId} write={write} canAdjust={canEdit("logistics")} />
        </TabsContent>

        <TabsContent value="log" className="pt-4">
          <MaintenanceLogTab
            factoryId={factoryId}
            write={write}
            vehicles={vehicles.data ?? []}
            requests={allRequests}
          />
        </TabsContent>

        <TabsContent value="issues" className="pt-4">
          <IssueApprovalsTab factoryId={factoryId} />
        </TabsContent>

        <TabsContent value="movements" className="pt-4">
          <StockMovementsTab factoryId={factoryId} />
        </TabsContent>

        <TabsContent value="requests" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {Object.entries(STATUS_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {write && (
              <Button onClick={() => setRequestOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> New Request
              </Button>
            )}
          </div>
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <SearchBox value={q} onChange={setQ} className="mb-3" />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Request #</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Machine / Vehicle</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead className="text-right">Estimate</TableHead>
                    <TableHead className="text-right">Spent</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Requested by</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRequests.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <RefId id={r.id} />
                      </TableCell>
                      <TableCell className="font-medium whitespace-nowrap">
                        {r.request_number}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {CATEGORY_LABELS[r.category] ?? r.category}
                      </TableCell>
                      <TableCell>{r.title}</TableCell>
                      <TableCell>{r.vehicles?.plate_number ?? r.asset_name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={priorityVariant(r.priority)} className="capitalize">
                          {r.priority}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {r.estimated_cost != null ? money(Number(r.estimated_cost)) : "—"}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {spentByRequest.has(r.id) ? money(spentByRequest.get(r.id)) : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(r.status)} className="whitespace-nowrap">
                          {STATUS_LABELS[r.status] ?? r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {r.requested_by_name ?? "—"}
                        <div className="text-muted-foreground">
                          {new Date(r.created_at).toLocaleDateString()}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Open"
                          onClick={() => setViewingId(r.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {visibleRequests.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                        {requests.isError
                          ? "Couldn't load maintenance requests."
                          : "No maintenance requests."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vehicles" className="space-y-4 pt-4">
          {write && (
            <div className="flex justify-end">
              <Button onClick={() => setVehicleOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add Vehicle
              </Button>
            </div>
          )}
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <SearchBox value={q} onChange={setQ} className="mb-3" />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Plate</TableHead>
                    <TableHead>Brand / Model</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Year</TableHead>
                    <TableHead>Capacity</TableHead>
                    <TableHead>Status</TableHead>
                    {write && <TableHead></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(vehicles.data ?? [])
                    .filter((x) => matchesSearch(q, x))
                    .map((v) => (
                      <TableRow key={v.id}>
                        <TableCell>
                          <RefId id={v.id} />
                        </TableCell>
                        <TableCell className="font-medium">{v.plate_number}</TableCell>
                        <TableCell>{[v.brand, v.model].filter(Boolean).join(" ") || "—"}</TableCell>
                        <TableCell className="capitalize">{v.vehicle_type ?? "—"}</TableCell>
                        <TableCell>{v.year ?? "—"}</TableCell>
                        <TableCell>{v.capacity ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {v.status}
                          </Badge>
                        </TableCell>
                        {write && (
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Edit"
                                onClick={() => {
                                  setEditingVehicle(v);
                                  setVForm({
                                    plate_number: v.plate_number,
                                    brand: v.brand ?? "",
                                    model: v.model ?? "",
                                    vehicle_type: v.vehicle_type ?? "",
                                    year: v.year != null ? String(v.year) : "",
                                    color: v.color ?? "",
                                    capacity: v.capacity ?? "",
                                    chassis_number: v.chassis_number ?? "",
                                    engine_number: v.engine_number ?? "",
                                    registration_expiry_date: v.registration_expiry_date ?? "",
                                    insurance_expiry_date: v.insurance_expiry_date ?? "",
                                    status: v.status,
                                  });
                                  setVehicleOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Remove"
                                onClick={() => setDeleteVehicleTarget(v)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  {(vehicles.data?.length ?? 0) === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={write ? 8 : 7}
                        className="text-center text-muted-foreground py-8"
                      >
                        No vehicles on file.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ---------- new request ---------- */}
      <Dialog
        open={requestOpen}
        onOpenChange={(v) => {
          setRequestOpen(v);
          if (!v) setRForm(emptyRequestForm);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Maintenance Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={rForm.category}
                  onValueChange={(v) =>
                    setRForm({
                      ...rForm,
                      category: v,
                      vehicle_id: v === "vehicle_repair" ? rForm.vehicle_id : "",
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select category…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select
                  value={rForm.priority}
                  onValueChange={(v) => setRForm({ ...rForm, priority: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                placeholder="e.g. Replace blowing machine heater bands"
                value={rForm.title}
                onChange={(e) => setRForm({ ...rForm, title: e.target.value })}
              />
            </div>
            {rForm.category === "vehicle_repair" ? (
              <div className="space-y-2">
                <Label>Vehicle</Label>
                <Select
                  value={rForm.vehicle_id}
                  onValueChange={(v) => setRForm({ ...rForm, vehicle_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        (vehicles.data?.length ?? 0) === 0
                          ? "No vehicles — add one in the Vehicles tab"
                          : "Select vehicle"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(vehicles.data ?? []).map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.plate_number}
                        {v.brand || v.model
                          ? ` — ${[v.brand, v.model].filter(Boolean).join(" ")}`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Machine / area (optional)</Label>
                <Input
                  placeholder="e.g. Sachet machine 2, generator house"
                  value={rForm.asset_name}
                  onChange={(e) => setRForm({ ...rForm, asset_name: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Details</Label>
              <Textarea
                rows={3}
                placeholder="What's wrong or what's needed, and why"
                value={rForm.description}
                onChange={(e) => setRForm({ ...rForm, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Estimated cost (optional)</Label>
              <Input
                type="number"
                min="0"
                value={rForm.estimated_cost}
                onChange={(e) => setRForm({ ...rForm, estimated_cost: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!rForm.category || !rForm.title.trim() || createRequest.isPending}
              onClick={() => createRequest.mutate()}
            >
              Submit for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- request detail ---------- */}
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewingId(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  {viewing.request_number}
                  <Badge variant={statusVariant(viewing.status)}>
                    {STATUS_LABELS[viewing.status] ?? viewing.status}
                  </Badge>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 text-sm">
                <div>
                  <div className="text-base font-medium">{viewing.title}</div>
                  <div className="text-muted-foreground">
                    {CATEGORY_LABELS[viewing.category] ?? viewing.category}
                    {(viewing.vehicles?.plate_number ?? viewing.asset_name) &&
                      ` · ${viewing.vehicles?.plate_number ?? viewing.asset_name}`}
                    {` · ${viewing.priority} priority`}
                  </div>
                  {viewing.description && (
                    <p className="mt-2 whitespace-pre-wrap">{viewing.description}</p>
                  )}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">Requested by: </span>
                    {viewing.requested_by_name ?? "—"} on{" "}
                    {new Date(viewing.created_at).toLocaleString()}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Estimate: </span>
                    {viewing.estimated_cost != null ? money(Number(viewing.estimated_cost)) : "—"}
                  </div>
                  {viewing.decided_at && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">
                        {viewing.status === "rejected" ? "Rejected" : "Approved"} by:{" "}
                      </span>
                      {viewing.decided_by_name ?? "—"} on{" "}
                      {new Date(viewing.decided_at).toLocaleString()}
                    </div>
                  )}
                  {viewing.decision_note && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">
                        {viewing.status === "cancelled" ? "Cancellation reason" : "Approver's note"}
                        :{" "}
                      </span>
                      {viewing.decision_note}
                    </div>
                  )}
                  {viewing.completed_at && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">Completed by: </span>
                      {viewing.completed_by_name ?? "—"} on{" "}
                      {new Date(viewing.completed_at).toLocaleString()}
                      {viewing.completion_notes && ` — ${viewing.completion_notes}`}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">
                      Purchases &amp; payments · {money(viewingSpent)}
                    </div>
                    {write && viewing.status === "approved" && (
                      <Button size="sm" variant="outline" onClick={() => setPurchaseOpen(true)}>
                        <ShoppingCart className="mr-2 h-4 w-4" /> Log Purchase
                      </Button>
                    )}
                  </div>
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Item / service</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Unit cost</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Vendor</TableHead>
                          <TableHead>Receipt</TableHead>
                          <TableHead>Logged by</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {viewingPurchases.map((p) => (
                          <TableRow key={p.id}>
                            <TableCell className="whitespace-nowrap">
                              {new Date(p.purchase_date).toLocaleDateString()}
                            </TableCell>
                            <TableCell>
                              {p.item_description}
                              {p.notes && (
                                <div className="text-xs text-muted-foreground">{p.notes}</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right">{Number(p.quantity)}</TableCell>
                            <TableCell className="text-right whitespace-nowrap">
                              {money(Number(p.unit_cost))}
                            </TableCell>
                            <TableCell className="text-right whitespace-nowrap">
                              {money(Number(p.amount))}
                            </TableCell>
                            <TableCell>{p.vendor ?? "—"}</TableCell>
                            <TableCell>{p.receipt_ref ?? "—"}</TableCell>
                            <TableCell className="text-xs">{p.recorded_by_name ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                        {viewingPurchases.length === 0 && (
                          <TableRow>
                            <TableCell
                              colSpan={8}
                              className="text-center text-muted-foreground py-6"
                            >
                              {viewing.status === "pending_approval"
                                ? "Purchases can be logged once the request is approved."
                                : "No purchases logged."}
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
              <DialogFooter className="flex-wrap gap-2">
                {canCancelViewing && (
                  <Button variant="ghost" onClick={() => setNoteAction("cancel")}>
                    <Ban className="mr-2 h-4 w-4" /> Cancel request
                  </Button>
                )}
                {viewing.status === "pending_approval" && canReject("logistics") && (
                  <Button variant="destructive" onClick={() => setNoteAction("reject")}>
                    <X className="mr-2 h-4 w-4" /> Reject
                  </Button>
                )}
                {viewing.status === "pending_approval" && canApprove("logistics") && (
                  <Button onClick={() => setNoteAction("approve")}>
                    <Check className="mr-2 h-4 w-4" /> Approve
                  </Button>
                )}
                {viewing.status === "approved" && canEdit("logistics") && (
                  <Button onClick={() => setNoteAction("complete")}>
                    <CircleCheck className="mr-2 h-4 w-4" /> Mark completed
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------- approve / reject / complete / cancel ---------- */}
      <Dialog
        open={!!noteAction}
        onOpenChange={(v) => {
          if (!v) {
            setNoteAction(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{noteAction ? noteTitle[noteAction] : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>
              {noteAction === "complete"
                ? "What was done (optional)"
                : noteRequired
                  ? "Reason"
                  : "Note (optional)"}
            </Label>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            {noteAction === "complete" && (
              <p className="text-xs text-muted-foreground">
                Log every purchase first — no more can be added once the request is completed.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant={
                noteAction === "reject" || noteAction === "cancel" ? "destructive" : "default"
              }
              disabled={(noteRequired && !note.trim()) || runNoteAction.isPending}
              onClick={() => runNoteAction.mutate()}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- log purchase ---------- */}
      <Dialog
        open={purchaseOpen}
        onOpenChange={(v) => {
          setPurchaseOpen(v);
          if (!v) setPForm(emptyPurchaseForm());
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Log Purchase — {viewing?.request_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Add to parts stock (optional)</Label>
              <Select
                value={pForm.part_id || "none"}
                onValueChange={(v) => {
                  const part = (parts.data ?? []).find((p) => p.id === v);
                  setPForm({
                    ...pForm,
                    part_id: part ? part.id : "",
                    item_description: part ? part.name : pForm.item_description,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    Not a stocked part (service, labour, one-off)
                  </SelectItem>
                  {(parts.data ?? [])
                    .filter((p) => p.is_active)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.part_number ? ` (${p.part_number})` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {pForm.part_id && (
                <p className="text-xs text-muted-foreground">
                  The quantity bought is added to this part's stock.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Item / service</Label>
              <Input
                placeholder="e.g. Heater band 220V, mechanic labour"
                value={pForm.item_description}
                onChange={(e) => setPForm({ ...pForm, item_description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Quantity</Label>
                <Input
                  type="number"
                  min="0"
                  value={pForm.quantity}
                  onChange={(e) => setPForm({ ...pForm, quantity: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Unit cost</Label>
                <Input
                  type="number"
                  min="0"
                  value={pForm.unit_cost}
                  onChange={(e) => setPForm({ ...pForm, unit_cost: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Amount</Label>
                <div className="flex h-9 items-center text-sm font-medium">
                  {money((Number(pForm.quantity) || 0) * (Number(pForm.unit_cost) || 0))}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={pForm.purchase_date}
                  onChange={(e) => setPForm({ ...pForm, purchase_date: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Vendor / mechanic</Label>
                <Input
                  value={pForm.vendor}
                  onChange={(e) => setPForm({ ...pForm, vendor: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Receipt / invoice no. (optional)</Label>
              <Input
                value={pForm.receipt_ref}
                onChange={(e) => setPForm({ ...pForm, receipt_ref: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                rows={2}
                value={pForm.notes}
                onChange={(e) => setPForm({ ...pForm, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={
                !pForm.item_description.trim() ||
                !(Number(pForm.quantity) > 0) ||
                pForm.unit_cost === "" ||
                Number(pForm.unit_cost) < 0 ||
                addPurchase.isPending
              }
              onClick={() => addPurchase.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- vehicles ---------- */}
      <Dialog
        open={vehicleOpen}
        onOpenChange={(v) => {
          setVehicleOpen(v);
          if (!v) resetVehicleForm();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingVehicle ? "Edit Vehicle" : "Add Vehicle"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Plate number</Label>
                <Input
                  value={vForm.plate_number}
                  onChange={(e) => setVForm({ ...vForm, plate_number: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Vehicle type</Label>
                <Select
                  value={vForm.vehicle_type}
                  onValueChange={(v) => setVForm({ ...vForm, vehicle_type: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="van">Van</SelectItem>
                    <SelectItem value="truck">Truck</SelectItem>
                    <SelectItem value="bus">Bus</SelectItem>
                    <SelectItem value="car">Car</SelectItem>
                    <SelectItem value="motorcycle">Motorcycle</SelectItem>
                    <SelectItem value="tricycle">Tricycle</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Brand</Label>
                <Input
                  placeholder="e.g. Toyota"
                  value={vForm.brand}
                  onChange={(e) => setVForm({ ...vForm, brand: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Model</Label>
                <Input
                  placeholder="e.g. Hiace"
                  value={vForm.model}
                  onChange={(e) => setVForm({ ...vForm, model: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Year</Label>
                <Input
                  type="number"
                  value={vForm.year}
                  onChange={(e) => setVForm({ ...vForm, year: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Color</Label>
                <Input
                  value={vForm.color}
                  onChange={(e) => setVForm({ ...vForm, color: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Capacity</Label>
                <Input
                  placeholder="e.g. 1000kg"
                  value={vForm.capacity}
                  onChange={(e) => setVForm({ ...vForm, capacity: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={vForm.status}
                  onValueChange={(v) => setVForm({ ...vForm, status: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="maintenance">Maintenance</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Chassis / VIN number</Label>
                <Input
                  value={vForm.chassis_number}
                  onChange={(e) => setVForm({ ...vForm, chassis_number: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Engine number</Label>
                <Input
                  value={vForm.engine_number}
                  onChange={(e) => setVForm({ ...vForm, engine_number: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Registration expiry</Label>
                <Input
                  type="date"
                  value={vForm.registration_expiry_date}
                  onChange={(e) => setVForm({ ...vForm, registration_expiry_date: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Insurance expiry</Label>
                <Input
                  type="date"
                  value={vForm.insurance_expiry_date}
                  onChange={(e) => setVForm({ ...vForm, insurance_expiry_date: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!vForm.plate_number || addVehicle.isPending || updateVehicle.isPending}
              onClick={() => (editingVehicle ? updateVehicle.mutate() : addVehicle.mutate())}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RequestDeleteDialog
        open={!!deleteVehicleTarget}
        onOpenChange={(v) => !v && setDeleteVehicleTarget(null)}
        isPending={deleteVehicle.isPending}
        title={
          deleteVehicleTarget
            ? `Request deletion — ${deleteVehicleTarget.plate_number}`
            : "Request deletion"
        }
        onConfirm={(reason) =>
          deleteVehicleTarget && deleteVehicle.mutate({ id: deleteVehicleTarget.id, reason })
        }
      />
    </div>
  );
}
