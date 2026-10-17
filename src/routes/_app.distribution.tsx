import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { Fragment, useMemo, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  Pencil,
  Undo2,
  Ban,
  Eye,
  Loader2,
  Send,
  FileDown,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { QuickAddProductDialog, ADD_NEW_ITEM } from "@/components/shared/quick-add-item";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";

export const Route = createFileRoute("/_app/distribution")({
  head: () => ({
    meta: [{ title: "Distribution — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  // ?tab= opens a specific tab (Finance links Cash remitted to
  // ?tab=remittances); no param means the default Sales Reps tab.
  validateSearch: (s: Record<string, unknown>): { tab?: string } => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  // Marketer & retail accounts moved to the Accountant page; old links follow.
  beforeLoad: ({ search }) => {
    if (search.tab === "accounts")
      throw redirect({ to: "/accountant", search: { tab: "accounts" } });
  },
  component: () => (
    <>
      <SectionTabs section="Distribution" />
      <RequireAccess module="distribution">
        <DistributionPage />
      </RequireAccess>
    </>
  ),
});

export type Rep = {
  id: string;
  code: string | null;
  full_name: string;
  phone: string | null;
  status: string;
  employee_id: string | null;
  remarks: string | null;
  // 'rep' is a field sales rep; 'outlet' is the company's own retail outlet.
  // Both hold stock dispatched from the Warehouse and sell from it.
  kind: "rep" | "outlet";
};
// How a stock holder reads in pickers: outlets are marked so they aren't
// mistaken for a rep.
const repLabel = (r: { full_name: string; kind?: string }) =>
  r.kind === "outlet" ? `${r.full_name} (Retail outlet)` : r.full_name;
type Product = {
  id: string;
  name: string;
  unit: string;
  unit_price: number;
  current_stock: number;
};
type NamedRow = { id: string; name?: string; full_name?: string; plate_number?: string };
type DispatchRow = {
  id: string;
  dispatch_number: string;
  dispatch_date: string;
  status: string;
  total_value: number;
  notes: string | null;
  sales_reps: { full_name: string } | null;
  stock_dispatch_items: {
    quantity: number;
    unit_price: number;
    line_value: number;
    products: { name: string; unit: string } | null;
  }[];
};
type ReturnRow = {
  id: string;
  return_number: string;
  return_date: string;
  status: string;
  received_by: string;
  notes: string | null;
  sales_rep_id: string;
  sales_reps: { full_name: string; kind?: string } | null;
  carried: { dispatch_number: string; status: string } | null;
  rep_return_items: {
    id: string;
    product_id: string;
    quantity_returned: number;
    unit_price: number;
    accepted_quantity: number | null;
    damaged_quantity: number;
    rejected_quantity: number;
    charge_rep: boolean;
    products: { name: string; unit: string } | null;
  }[];
};
type RemittanceRow = {
  id: string;
  remittance_number: string;
  remittance_date: string;
  amount: number;
  payment_method: string;
  remarks: string | null;
  sales_reps: { full_name: string } | null;
};

const statusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "completed" || s === "posted") return "secondary";
  if (s === "cancelled" || s === "reversed") return "destructive";
  return "outline";
};

function DistributionPage() {
  const { data: factoryId } = useFactoryId();
  const perms = usePermissions();
  // Cash remitted, credit and account balances are Accounting's: only people
  // with a finance-side right see Remittances (not the Warehouse). Marketer &
  // retail accounts live on the Accountant page.
  const canMoney = perms.canSeeMoney;
  const { tab: urlTab } = Route.useSearch();
  const tab = !canMoney && urlTab === "remittances" ? undefined : urlTab;
  const navigate = useNavigate({ from: Route.fullPath });
  // Keep the tab in the URL so Finance's Marketer Accounts links land on it,
  // and keep the history state so the sidebar/tab bar stay on the same entry.
  const setTab = (v: string) =>
    navigate({
      search: { tab: v === "reps" ? undefined : v },
      replace: true,
      state: (prev) => prev,
    });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const reps = useQuery({
    queryKey: ["dist-reps", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,code,full_name,phone,status,employee_id,remarks,kind")
        .eq("factory_id", factoryId!)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Rep[];
    },
  });

  const products = useQuery({
    queryKey: ["dist-products", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,unit_price,current_stock")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });

  const vehicles = useQuery({
    queryKey: ["dist-vehicles", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data } = await supabase
        .from("vehicles")
        .select("id,plate_number")
        .eq("factory_id", factoryId!)
        .order("plate_number");
      return (data ?? []) as NamedRow[];
    },
  });
  const drivers = useQuery({
    queryKey: ["dist-drivers", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data } = await supabase
        .from("drivers")
        .select("id,full_name")
        .eq("factory_id", factoryId!)
        .order("full_name");
      return (data ?? []) as NamedRow[];
    },
  });
  const routes = useQuery({
    queryKey: ["dist-routes", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data } = await supabase
        .from("delivery_routes")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      return (data ?? []) as NamedRow[];
    },
  });

  if (!factoryId) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Distribution</h1>
        <p className="text-sm text-muted-foreground">
          Products leave the warehouse on a dispatch to a sales rep or the company's retail outlet.
          Each sells from its own stock, returns what's unsold for inspection, and remits cash — its
          account nets it all against the value of goods it took.
        </p>
      </div>

      <Tabs value={tab ?? "reps"} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="reps">Reps &amp; Outlets</TabsTrigger>
          <TabsTrigger value="dispatches">Dispatches</TabsTrigger>
          <TabsTrigger value="returns">Returns</TabsTrigger>
          {canMoney && <TabsTrigger value="remittances">Remittances</TabsTrigger>}
        </TabsList>

        <TabsContent value="reps" className="mt-4">
          <RepsTab factoryId={factoryId} reps={reps.data ?? []} perms={perms} />
        </TabsContent>
        <TabsContent value="dispatches" className="mt-4">
          <DispatchesTab
            factoryId={factoryId}
            reps={(reps.data ?? []).filter((r) => r.status === "active")}
            products={products.data ?? []}
            vehicles={vehicles.data ?? []}
            drivers={drivers.data ?? []}
            routes={routes.data ?? []}
            perms={perms}
          />
        </TabsContent>
        <TabsContent value="returns" className="mt-4">
          <ReturnsTab
            factoryId={factoryId}
            reps={reps.data ?? []}
            products={products.data ?? []}
            perms={perms}
            currentUserId={currentUser.data ?? null}
          />
        </TabsContent>
        <TabsContent value="remittances" className="mt-4">
          <RemittancesTab
            factoryId={factoryId}
            reps={(reps.data ?? []).filter((r) => r.status === "active")}
            perms={perms}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Perms = ReturnType<typeof usePermissions>;

/* ------------------------------------------------------------------ Reps --- */

function RepsTab({ factoryId, reps, perms }: { factoryId: string; reps: Rep[]; perms: Perms }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Rep | null>(null);
  const [open, setOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Rep | null>(null);
  const [viewing, setViewing] = useState<Rep | null>(null);
  const canCreate = perms.canCreate("distribution");
  const canEdit = perms.canEdit("distribution");
  const canDelete = perms.canDelete("distribution");

  const refresh = () => qc.invalidateQueries({ queryKey: ["dist-reps"] });

  const del = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await requestDelete("sales_reps", id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Sales Reps &amp; Retail Outlets</CardTitle>
        {canCreate && (
          <Button
            size="sm"
            className="gap-2"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Add Rep / Outlet
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reps.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                title="Click to see this account and all its activity"
                onClick={() => setViewing(r)}
              >
                <TableCell className="font-mono text-xs">{r.code ?? "—"}</TableCell>
                <TableCell className="font-medium text-primary">{r.full_name}</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {r.kind === "outlet" ? "Retail outlet" : "Sales rep"}
                  </Badge>
                </TableCell>
                <TableCell>{r.phone ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={r.status === "active" ? "secondary" : "outline"}>
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit"
                        onClick={() => {
                          setEditing(r);
                          setOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete"
                        onClick={() => setDeleteTarget(r)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {reps.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No sales reps or outlets yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        {viewing && <RepDetailsDialog factoryId={factoryId} rep={viewing} />}
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <RepDialog
            factoryId={factoryId}
            rep={editing}
            onDone={() => {
              setOpen(false);
              refresh();
            }}
          />
        )}
      </Dialog>

      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={del.isPending}
        title={deleteTarget ? `Request deletion — ${deleteTarget.full_name}` : "Request deletion"}
        onConfirm={(reason) => deleteTarget && del.mutate({ id: deleteTarget.id, reason })}
      />
    </Card>
  );
}

function RepDialog({
  factoryId,
  rep,
  onDone,
}: {
  factoryId: string;
  rep: Rep | null;
  onDone: () => void;
}) {
  const [fullName, setFullName] = useState(rep?.full_name ?? "");
  // Auto-generated by a DB trigger on insert (sales_reps_set_code: SR-01…,
  // OUTLET-01…) — never user-editable, so it is read from `rep` only.
  const code = rep?.code ?? "";
  const [phone, setPhone] = useState(rep?.phone ?? "");
  const [status, setStatus] = useState(rep?.status ?? "active");
  const [remarks, setRemarks] = useState(rep?.remarks ?? "");
  const [kind, setKind] = useState<Rep["kind"]>(rep?.kind ?? "rep");

  const save = useMutation({
    mutationFn: async () => {
      if (!fullName.trim()) throw new Error("Name is required");
      const body = {
        factory_id: factoryId,
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        status,
        kind,
        remarks: remarks.trim() || null,
      };
      if (rep) {
        const { error } = await supabase.from("sales_reps").update(body).eq("id", rep.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("sales_reps").insert(body);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      const what = kind === "outlet" ? "Outlet" : "Rep";
      toast.success(rep ? `${what} updated` : `${what} added`);
      logAudit({ action: rep ? "update" : "create", entity: "sales_reps", factoryId });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{rep ? "Edit Rep / Outlet" : "Add Rep / Outlet"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Type</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as Rep["kind"])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rep">Sales rep — sells from a van, earns commission</SelectItem>
              <SelectItem value="outlet">
                Retail outlet — company shop, sells to walk-ins
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>{kind === "outlet" ? "Outlet name" : "Full name"}</Label>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Code</Label>
            <Input value={rep ? code : "Auto-generated on save"} disabled />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {rep ? "Save" : "Add"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ------------------------------------------------------------- Dispatches --- */

type Line = { product_id: string; quantity: number };

function DispatchesTab({
  factoryId,
  reps,
  products,
  vehicles,
  drivers,
  routes,
  perms,
}: {
  factoryId: string;
  reps: Rep[];
  products: Product[];
  vehicles: NamedRow[];
  drivers: NamedRow[];
  routes: NamedRow[];
  perms: Perms;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<DispatchRow | null>(null);
  const [detail, setDetail] = useState<DispatchRow | null>(null);
  const canCreate = perms.canCreate("distribution");
  const canReverse = perms.canReverse("distribution");

  const list = useQuery({
    queryKey: ["dist-dispatches", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_dispatches")
        .select(
          "id,dispatch_number,dispatch_date,status,total_value,notes,sales_reps(full_name),stock_dispatch_items(quantity,unit_price,line_value,products(name,unit))",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as DispatchRow[];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dist-dispatches"] });
    qc.invalidateQueries({ queryKey: ["dist-products"] });
    qc.invalidateQueries({ queryKey: ["dist-rep-stock"] });
    qc.invalidateQueries({ queryKey: ["dist-account"] });
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Dispatches</CardTitle>
        {canCreate && (
          <Button size="sm" className="gap-2" onClick={() => setOpen(true)}>
            <Send className="h-4 w-4" /> New Dispatch
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dispatch #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Rep</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{d.dispatch_number}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {new Date(d.dispatch_date).toLocaleDateString()}
                </TableCell>
                <TableCell className="font-medium">{d.sales_reps?.full_name ?? "—"}</TableCell>
                <TableCell className="text-right">{d.stock_dispatch_items?.length ?? 0}</TableCell>
                <TableCell className="text-right">{money(Number(d.total_value))}</TableCell>
                <TableCell>
                  <Badge variant={statusBadge(d.status)} className="capitalize">
                    {d.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" title="View" onClick={() => setDetail(d)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    {d.status === "posted" && canReverse && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Reverse"
                        onClick={() => setReverseTarget(d)}
                      >
                        <Undo2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No dispatches yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <NewDispatchDialog
            factoryId={factoryId}
            reps={reps}
            products={products}
            vehicles={vehicles}
            drivers={drivers}
            routes={routes}
            onDone={() => {
              setOpen(false);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!reverseTarget} onOpenChange={(v) => !v && setReverseTarget(null)}>
        {reverseTarget && (
          <ReverseDialog
            row={reverseTarget}
            onDone={() => {
              setReverseTarget(null);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        {detail && (
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{detail.dispatch_number}</DialogTitle>
            </DialogHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.stock_dispatch_items?.map((it, i) => (
                  <TableRow key={i}>
                    <TableCell>{it.products?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {num(Number(it.quantity))} {it.products?.unit}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(it.unit_price))}</TableCell>
                    <TableCell className="text-right">{money(Number(it.line_value))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {detail.notes && <p className="text-sm text-muted-foreground">Notes: {detail.notes}</p>}
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}

function LineEditor({
  products,
  lines,
  setLines,
  stockOf,
  qtyLabel = "Qty",
  factoryId,
}: {
  products: Product[];
  lines: Line[];
  setLines: (l: Line[]) => void;
  stockOf: (productId: string) => number;
  qtyLabel?: string;
  // When set, the product dropdown offers "+ Add new product…".
  factoryId?: string;
}) {
  const [addingFor, setAddingFor] = useState<number | null>(null);
  const add = () => setLines([...lines, { product_id: "", quantity: 0 }]);
  const update = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => setLines(lines.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {lines.map((l, i) => {
        const p = products.find((x) => x.id === l.product_id);
        const avail = l.product_id ? stockOf(l.product_id) : null;
        return (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1">
              <Label className="text-xs">Product</Label>
              <Select
                value={l.product_id}
                onValueChange={(v) =>
                  v === ADD_NEW_ITEM ? setAddingFor(i) : update(i, { product_id: v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  {factoryId && (
                    <SelectItem value={ADD_NEW_ITEM} className="font-medium text-primary">
                      + Add new product…
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="w-28">
              <Label className="text-xs">
                {qtyLabel}
                {avail != null && (
                  <span className="ml-1 text-muted-foreground">({num(avail)})</span>
                )}
              </Label>
              <MoneyInput
                min={0}
                value={l.quantity || 0}
                onChange={(v) => update(i, { quantity: v })}
              />
            </div>
            <div className="w-24 pb-2 text-right text-xs text-muted-foreground">
              {p ? money(p.unit_price * (l.quantity || 0)) : "—"}
            </div>
            <Button variant="ghost" size="icon" onClick={() => remove(i)}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        );
      })}
      <Button variant="outline" size="sm" className="gap-2" onClick={add}>
        <Plus className="h-4 w-4" /> Add line
      </Button>
      {factoryId && (
        <QuickAddProductDialog
          open={addingFor !== null}
          onOpenChange={(v) => !v && setAddingFor(null)}
          factoryId={factoryId}
          onCreated={(id) => {
            if (addingFor !== null) update(addingFor, { product_id: id });
          }}
        />
      )}
    </div>
  );
}

function NewDispatchDialog({
  factoryId,
  reps,
  products,
  vehicles,
  drivers,
  routes,
  onDone,
  kind,
  fixedRepId,
  embedded,
  carryReturn,
}: {
  factoryId: string;
  reps: Rep[];
  products: Product[];
  vehicles: NamedRow[];
  drivers: NamedRow[];
  routes: NamedRow[];
  onDone: () => void;
  // Marketer returns → "Add products": the returned products are still on
  // the van, so the dispatch starts with them and is linked to the return.
  carryReturn?: { id: string; return_number: string; lines: Line[] };
  // Set when opened for one kind of holder (Warehouse "Post" menu): the
  // picker only offers that kind, and a lone holder is preselected.
  kind?: Rep["kind"];
  // Holder already chosen by the caller: no picker is shown.
  fixedRepId?: string;
  // Render just the form, for use inside another dialog.
  embedded?: boolean;
}) {
  const [pickedRepId, setRepId] = useState(kind && reps.length === 1 ? reps[0].id : "");
  const repId = fixedRepId ?? pickedRepId;
  const holderLabel =
    kind === "outlet" ? "Retail shop" : kind === "rep" ? "Marketer" : "Rep / outlet";
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [vehicleId, setVehicleId] = useState("none");
  const [driverId, setDriverId] = useState("none");
  const [routeId, setRouteId] = useState("none");
  const [notes, setNotes] = useState(
    carryReturn ? `Carried over from return ${carryReturn.return_number}` : "",
  );
  const [lines, setLines] = useState<Line[]>(
    carryReturn?.lines.length ? carryReturn.lines : [{ product_id: "", quantity: 0 }],
  );

  const total = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const p = products.find((x) => x.id === l.product_id);
        return sum + (p ? p.unit_price * (l.quantity || 0) : 0);
      }, 0),
    [lines, products],
  );

  const submit = useMutation({
    mutationFn: async () => {
      if (!repId) throw new Error(`Select a ${holderLabel.toLowerCase()}`);
      const clean = lines.filter((l) => l.product_id && l.quantity > 0);
      if (clean.length === 0) throw new Error("Add at least one product line");
      const { data, error } = await supabase.rpc("create_stock_dispatch", {
        payload: {
          factory_id: factoryId,
          sales_rep_id: repId,
          dispatch_date: date,
          vehicle_id: vehicleId === "none" ? undefined : vehicleId,
          driver_id: driverId === "none" ? undefined : driverId,
          route_id: routeId === "none" ? undefined : routeId,
          notes: notes || undefined,
          carry_return_id: carryReturn?.id,
          items: clean.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
        } as never,
      });
      if (error) throw error;
      return data as { dispatch_number?: string; id?: string };
    },
    onSuccess: (data) => {
      toast.success(`Dispatch ${data?.dispatch_number ?? ""} posted`);
      logAudit({ action: "create", entity: "stock_dispatches", entityId: data?.id, factoryId });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const body = (
    <>
      <div className="grid gap-3">
        {kind && !fixedRepId && reps.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {kind === "outlet"
              ? "No active retail shop is set up. Add one under Distribution → Reps & Outlets."
              : "No active marketer is set up. Add one under Distribution → Reps & Outlets."}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {!fixedRepId && (
            <div>
              <Label>{holderLabel}</Label>
              <Select value={repId} onValueChange={setRepId}>
                <SelectTrigger>
                  <SelectValue placeholder={`Select ${holderLabel.toLowerCase()}…`} />
                </SelectTrigger>
                <SelectContent>
                  {reps.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {repLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Vehicle</Label>
            <Select value={vehicleId} onValueChange={setVehicleId}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {vehicles.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.plate_number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Driver</Label>
            <Select value={driverId} onValueChange={setDriverId}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {drivers.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Route</Label>
            <Select value={routeId} onValueChange={setRouteId}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {routes.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label>Products (warehouse stock shown in brackets)</Label>
          <LineEditor
            products={products}
            lines={lines}
            setLines={setLines}
            stockOf={(id) => products.find((p) => p.id === id)?.current_stock ?? 0}
            factoryId={factoryId}
          />
        </div>

        <div>
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="flex justify-between border-t pt-2 text-sm font-medium">
          <span>Dispatch value</span>
          <span>{money(total)}</span>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Post dispatch
        </Button>
      </DialogFooter>
    </>
  );

  if (embedded) return body;
  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {kind === "outlet"
            ? "Post to Company Retail Shop"
            : kind === "rep"
              ? "Post to Marketer"
              : "New Dispatch — warehouse → rep / outlet"}
        </DialogTitle>
      </DialogHeader>
      {body}
    </DialogContent>
  );
}

// Everything the dispatch form picks from, for the Warehouse "Post" dialogs
// (same query keys as the Distribution page, so the caches are shared).
function useDispatchPickers(factoryId: string) {
  const reps = useQuery({
    queryKey: ["dist-reps", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,code,full_name,phone,status,employee_id,remarks,kind")
        .eq("factory_id", factoryId)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Rep[];
    },
  });
  const products = useQuery({
    queryKey: ["dist-products", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,unit_price,current_stock")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });
  const vehicles = useQuery({
    queryKey: ["dist-vehicles", factoryId],
    queryFn: async () => {
      const { data } = await supabase
        .from("vehicles")
        .select("id,plate_number")
        .eq("factory_id", factoryId)
        .order("plate_number");
      return (data ?? []) as NamedRow[];
    },
  });
  const drivers = useQuery({
    queryKey: ["dist-drivers", factoryId],
    queryFn: async () => {
      const { data } = await supabase
        .from("drivers")
        .select("id,full_name")
        .eq("factory_id", factoryId)
        .order("full_name");
      return (data ?? []) as NamedRow[];
    },
  });
  const routes = useQuery({
    queryKey: ["dist-routes", factoryId],
    queryFn: async () => {
      const { data } = await supabase
        .from("delivery_routes")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      return (data ?? []) as NamedRow[];
    },
  });
  return {
    loading: reps.isLoading || products.isLoading,
    holders: (kind: Rep["kind"]) =>
      (reps.data ?? []).filter((r) => r.kind === kind && r.status === "active"),
    products: products.data ?? [],
    vehicles: vehicles.data ?? [],
    drivers: drivers.data ?? [],
    routes: routes.data ?? [],
  };
}

function LoadingDialog({ title }: { title: string }) {
  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    </DialogContent>
  );
}

// Warehouse "Post → Company Retail Shop": the same dispatch as Distribution →
// Dispatches, offering only the active retail outlet(s).
export function PostToHolderDialog({
  factoryId,
  kind,
  onDone,
}: {
  factoryId: string;
  kind: Rep["kind"];
  onDone: () => void;
}) {
  const p = useDispatchPickers(factoryId);
  if (p.loading)
    return (
      <LoadingDialog
        title={kind === "outlet" ? "Post to Company Retail Shop" : "Post to Marketer"}
      />
    );
  return (
    <NewDispatchDialog
      factoryId={factoryId}
      kind={kind}
      reps={p.holders(kind)}
      products={p.products}
      vehicles={p.vehicles}
      drivers={p.drivers}
      routes={p.routes}
      onDone={onDone}
    />
  );
}

// The Warehouse's view of one marketer: stock only. What they hold now, what
// was posted to them, and the customers/offices under their name. Cash
// remitted, credit and balances are Accounting's (Finance → Marketer & Retail
// Accounts), so none of it is shown here.
function RepStockView({ repId }: { repId: string }) {
  const vanStock = useQuery({
    queryKey: ["dist-rep-stock", repId, "van-table"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock")
        .select("quantity,products(name,unit,unit_price)")
        .eq("sales_rep_id", repId)
        .gt("quantity", 0);
      if (error) throw error;
      return (data ?? []) as unknown as {
        quantity: number;
        products: { name: string; unit: string } | null;
      }[];
    },
  });
  const postings = useQuery({
    queryKey: ["dist-dispatches", "rep", repId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_dispatches")
        .select(
          "id,dispatch_number,dispatch_date,status,stock_dispatch_items(quantity,products(name,unit))",
        )
        .eq("sales_rep_id", repId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string;
        dispatch_number: string;
        dispatch_date: string;
        status: string;
        stock_dispatch_items: {
          quantity: number;
          products: { name: string; unit: string } | null;
        }[];
      }[];
    },
  });
  const customers = useQuery({
    queryKey: ["dist-rep-customer-accounts", repId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("rep_customers", { p_sales_rep_id: repId });
      if (error) throw error;
      return (data ?? []) as RepCustomer[];
    },
  });

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Stock on hand</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(vanStock.data ?? []).map((v, i) => (
                <TableRow key={i}>
                  <TableCell>{v.products?.name ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {num(Number(v.quantity))} {v.products?.unit}
                  </TableCell>
                </TableRow>
              ))}
              {(vanStock.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="py-6 text-center text-muted-foreground">
                    {vanStock.isLoading ? "Loading…" : "Holding no stock."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Customers &amp; offices</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Under this marketer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(customers.data ?? []).map((c) => (
                <TableRow key={c.customer_id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.phone ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={c.assigned ? "secondary" : "outline"}>
                      {c.assigned ? "Assigned" : "Sold to"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {(customers.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                    {customers.isLoading
                      ? "Loading…"
                      : "No customers yet. Assign them under Customers → Marketer."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Recent postings</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dispatch #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Products</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(postings.data ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-xs">{d.dispatch_number}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(d.dispatch_date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs">
                    {d.stock_dispatch_items
                      .map((it) => `${it.products?.name ?? "—"} × ${num(Number(it.quantity))}`)
                      .join(", ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadge(d.status)} className="capitalize">
                      {d.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {(postings.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    {postings.isLoading ? "Loading…" : "Nothing posted yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// Warehouse "Post → Marketers". Picking a marketer shows their stock record
// (RepStockView: stock held, postings, their customers/offices) next to the
// form for posting them new stock.
export function MarketerPostDialog({
  factoryId,
  onDone,
}: {
  factoryId: string;
  onDone: () => void;
}) {
  const perms = usePermissions();
  const qc = useQueryClient();
  const p = useDispatchPickers(factoryId);
  const [repId, setRepId] = useState("");
  const [tab, setTab] = useState<"account" | "post">("account");
  // "+ New marketer": the Warehouse adds a marketer on the spot. The new
  // sales_reps row is their account — every posting to them lands on it.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const addMarketer = useMutation({
    mutationFn: async () => {
      if (!newName.trim()) throw new Error("Enter the marketer's name");
      const { data, error } = await supabase
        .from("sales_reps")
        .insert({
          factory_id: factoryId,
          full_name: newName.trim(),
          phone: newPhone.trim() || null,
          status: "active",
          kind: "rep",
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: async (id) => {
      toast.success(`Marketer "${newName.trim()}" added`);
      logAudit({ action: "create", entity: "sales_reps", entityId: id, factoryId });
      await qc.invalidateQueries({ queryKey: ["dist-reps"] });
      setRepId(id);
      setTab("post");
      setAdding(false);
      setNewName("");
      setNewPhone("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (p.loading) return <LoadingDialog title="Post to Marketer" />;

  const marketers = p.holders("rep");
  const marketer = marketers.find((r) => r.id === repId);
  const canAdd = perms.canCreate("distribution");

  return (
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Marketers — stock &amp; posting</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full max-w-sm">
            <Label>Marketer</Label>
            <Select
              value={repId}
              onValueChange={(v) => (v === ADD_NEW_ITEM ? setAdding(true) : setRepId(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select marketer…" />
              </SelectTrigger>
              <SelectContent>
                {marketers.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
                    {r.code ? ` · ${r.code}` : ""}
                  </SelectItem>
                ))}
                {canAdd && (
                  <SelectItem value={ADD_NEW_ITEM} className="font-medium text-primary">
                    + New marketer…
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          {canAdd && !adding && (
            <Button variant="outline" className="gap-2" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> New marketer
            </Button>
          )}
        </div>

        {adding && (
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-base">New marketer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label>Full name</Label>
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
              </div>
              <div>
                <Label>Phone</Label>
                <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
              </div>
              <div>
                <Label>Code</Label>
                <Input value="Auto-generated on save" disabled />
              </div>
              <div className="flex gap-2 sm:col-span-3">
                <Button disabled={addMarketer.isPending} onClick={() => addMarketer.mutate()}>
                  {addMarketer.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Add marketer
                </Button>
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {marketers.length === 0 && !adding && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No marketer yet. Click New marketer to add one.
          </p>
        )}

        {marketer && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="account">Stock &amp; customers</TabsTrigger>
              {perms.canCreate("distribution") && (
                <TabsTrigger value="post">Post products</TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="account" className="pt-2">
              <RepStockView repId={marketer.id} />
            </TabsContent>
            {perms.canCreate("distribution") && (
              <TabsContent value="post" className="pt-2">
                <NewDispatchDialog
                  key={marketer.id}
                  embedded
                  kind="rep"
                  fixedRepId={marketer.id}
                  factoryId={factoryId}
                  reps={marketers}
                  products={p.products}
                  vehicles={p.vehicles}
                  drivers={p.drivers}
                  routes={p.routes}
                  onDone={onDone}
                />
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>
    </DialogContent>
  );
}

function ReverseDialog({ row, onDone }: { row: DispatchRow; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const run = useMutation({
    mutationFn: async () => {
      if (!reason.trim()) throw new Error("A reason is required");
      const { error } = await supabase.rpc("reverse_stock_dispatch", {
        p_id: row.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Dispatch reversed");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Reverse {row.dispatch_number}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Only possible while every dispatched unit is still on the rep's van. Stock goes back to the
        warehouse.
      </p>
      <div>
        <Label>Reason</Label>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="destructive" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Reverse
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ---------------------------------------------------------------- Returns --- */

export function ReturnsTab({
  factoryId,
  reps,
  products,
  perms,
  currentUserId,
  title = "Rep Returns",
  hideLog,
}: {
  factoryId: string;
  reps: Rep[];
  products: Product[];
  perms: Perms;
  currentUserId: string | null;
  title?: string;
  // Warehouse → Returns logs marketer returns from its own "Log Return" form
  // and shows this list for inspecting them, without a second button.
  hideLog?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<ReturnRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReturnRow | null>(null);
  const [carryTarget, setCarryTarget] = useState<ReturnRow | null>(null);
  const canSubmit = perms.canSubmit("distribution");
  // "Add products": send a marketer's returned (still on the van) products
  // back out to them in a new dispatch. Marketers only, not the retail shop.
  const canCarry = perms.canCreate("distribution");
  const carriedOver = (r: ReturnRow) => !!r.carried && r.carried.status !== "reversed";
  const canConfirm = perms.canConfirm("distribution");
  const canCancel = perms.canCancel("distribution");

  const list = useQuery({
    queryKey: ["dist-returns", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_returns")
        .select(
          "id,return_number,return_date,status,received_by,notes,sales_rep_id,sales_reps(full_name,kind),carried:stock_dispatches!rep_returns_carried_dispatch_id_fkey(dispatch_number,status),rep_return_items(id,product_id,quantity_returned,unit_price,accepted_quantity,damaged_quantity,rejected_quantity,charge_rep,products(name,unit))",
        )
        .eq("factory_id", factoryId!)
        .order("received_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as ReturnRow[];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dist-returns"] });
    qc.invalidateQueries({ queryKey: ["dist-products"] });
    qc.invalidateQueries({ queryKey: ["dist-rep-stock"] });
    qc.invalidateQueries({ queryKey: ["dist-account"] });
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        {canSubmit && !hideLog && (
          <Button size="sm" className="gap-2" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Log Return
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Return #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Rep</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.return_number}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {new Date(r.return_date).toLocaleDateString()}
                </TableCell>
                <TableCell className="font-medium">{r.sales_reps?.full_name ?? "—"}</TableCell>
                <TableCell className="text-right">{r.rep_return_items?.length ?? 0}</TableCell>
                <TableCell>
                  <Badge variant={statusBadge(r.status)} className="capitalize">
                    {r.status}
                  </Badge>
                  {carriedOver(r) && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Added to {r.carried!.dispatch_number}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {r.status === "completed" &&
                      canCarry &&
                      r.sales_reps?.kind !== "outlet" &&
                      !carriedOver(r) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          title="The returned products are still on the van: add them, plus anything extra, to the marketer's next dispatch"
                          onClick={() => setCarryTarget(r)}
                        >
                          <Plus className="h-4 w-4" /> Add products
                        </Button>
                      )}
                    {r.status === "received" && canConfirm && r.received_by !== currentUserId && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Inspect"
                        onClick={() => setInspectTarget(r)}
                      >
                        <Undo2 className="h-4 w-4 text-warning" />
                      </Button>
                    )}
                    {r.status === "received" && canCancel && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Cancel"
                        onClick={() => setCancelTarget(r)}
                      >
                        <Ban className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No rep returns yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <LogReturnDialog
            factoryId={factoryId}
            reps={reps}
            products={products}
            onDone={() => {
              setOpen(false);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!inspectTarget} onOpenChange={(v) => !v && setInspectTarget(null)}>
        {inspectTarget && (
          <InspectReturnDialog
            row={inspectTarget}
            onDone={() => {
              setInspectTarget(null);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!carryTarget} onOpenChange={(v) => !v && setCarryTarget(null)}>
        {carryTarget && (
          <CarryOverDialog
            factoryId={factoryId}
            row={carryTarget}
            onDone={() => {
              setCarryTarget(null);
              refresh();
              qc.invalidateQueries({ queryKey: ["dist-dispatches"] });
              qc.invalidateQueries({ queryKey: ["inventory-overview-products"] });
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && (
          <CancelReturnDialog
            row={cancelTarget}
            onDone={() => {
              setCancelTarget(null);
              refresh();
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

// Marketer returns → "Add products": a dispatch to the same marketer that
// starts with what they returned (accepted quantities), for the products that
// never left the van. More lines can be added for what else they carry.
function CarryOverDialog({
  factoryId,
  row,
  onDone,
}: {
  factoryId: string;
  row: ReturnRow;
  onDone: () => void;
}) {
  const p = useDispatchPickers(factoryId);
  const title = `Add products — ${row.sales_reps?.full_name ?? "marketer"}`;
  if (p.loading) return <LoadingDialog title={title} />;
  const lines = row.rep_return_items
    .map((it) => ({
      product_id: it.product_id,
      quantity: Number(it.accepted_quantity ?? it.quantity_returned),
    }))
    .filter((l) => l.quantity > 0);
  const rep = p.holders("rep").find((r) => r.id === row.sales_rep_id);
  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        What was recorded as returned on {row.return_number} is filled in below, since it is still
        on the van. Add any extra products they are carrying, then post. The total goes back on the
        marketer&apos;s stock and account, and comes off the Warehouse count.
      </p>
      {rep ? (
        <NewDispatchDialog
          factoryId={factoryId}
          kind="rep"
          fixedRepId={row.sales_rep_id}
          reps={[rep]}
          products={p.products}
          vehicles={p.vehicles}
          drivers={p.drivers}
          routes={p.routes}
          carryReturn={{ id: row.id, return_number: row.return_number, lines }}
          embedded
          onDone={onDone}
        />
      ) : (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          This marketer is no longer active, so nothing can be dispatched to them.
        </p>
      )}
    </DialogContent>
  );
}

function LogReturnDialog({
  factoryId,
  reps,
  products,
  onDone,
}: {
  factoryId: string;
  reps: Rep[];
  products: Product[];
  onDone: () => void;
}) {
  const [repId, setRepId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ product_id: "", quantity: 0 }]);

  const repStock = useQuery({
    queryKey: ["dist-rep-stock", repId],
    enabled: !!repId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock")
        .select("product_id,quantity")
        .eq("sales_rep_id", repId);
      if (error) throw error;
      return (data ?? []) as { product_id: string; quantity: number }[];
    },
  });
  const stockOf = (pid: string) =>
    Number(repStock.data?.find((r) => r.product_id === pid)?.quantity ?? 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (!repId) throw new Error("Select a sales rep");
      const clean = lines.filter((l) => l.product_id && l.quantity > 0);
      if (clean.length === 0) throw new Error("Add at least one line");
      const { data, error } = await supabase.rpc("create_rep_return", {
        payload: {
          factory_id: factoryId,
          sales_rep_id: repId,
          return_date: date,
          notes: notes || undefined,
          items: clean.map((l) => ({
            product_id: l.product_id,
            quantity_returned: l.quantity,
          })),
        } as never,
      });
      if (error) throw error;
      return data as { return_number?: string; id?: string };
    },
    onSuccess: (data) => {
      toast.success(`Return ${data?.return_number ?? ""} received — back in the Warehouse`);
      logAudit({ action: "create", entity: "rep_returns", entityId: data?.id, factoryId });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Log a Rep Return</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Rep / outlet</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Select rep or outlet…" />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {repLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Products (van stock shown in brackets)</Label>
          <LineEditor
            products={products}
            lines={lines}
            setLines={setLines}
            stockOf={stockOf}
            qtyLabel="Return"
          />
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Log return
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

type InspectLine = {
  item_id: string;
  name: string;
  unit: string;
  returned: number;
  accepted: number;
  damaged: number;
  rejected: number;
  charge_rep: boolean;
};

function InspectReturnDialog({ row, onDone }: { row: ReturnRow; onDone: () => void }) {
  const [lines, setLines] = useState<InspectLine[]>(
    row.rep_return_items.map((it) => ({
      item_id: it.id,
      name: it.products?.name ?? "—",
      unit: it.products?.unit ?? "",
      returned: Number(it.quantity_returned),
      accepted: Number(it.quantity_returned),
      damaged: 0,
      rejected: 0,
      charge_rep: true,
    })),
  );
  const [notes, setNotes] = useState("");

  const patch = (i: number, p: Partial<InspectLine>) =>
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...p } : l)));

  const run = useMutation({
    mutationFn: async () => {
      for (const l of lines) {
        if (l.accepted + l.damaged + l.rejected !== l.returned) {
          throw new Error(`${l.name}: accepted + damaged + rejected must equal ${l.returned}`);
        }
      }
      const { error } = await supabase.rpc("inspect_rep_return", {
        p_id: row.id,
        p_items: lines.map((l) => ({
          item_id: l.item_id,
          accepted_quantity: l.accepted,
          damaged_quantity: l.damaged,
          rejected_quantity: l.rejected,
          charge_rep: l.charge_rep,
        })) as never,
        p_notes: notes || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Return inspected — accepted stock posted to warehouse");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Inspect {row.return_number}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        {lines.map((l, i) => (
          <div key={l.item_id} className="rounded-lg border p-3">
            <div className="mb-2 flex justify-between text-sm font-medium">
              <span>{l.name}</span>
              <span className="text-muted-foreground">
                {num(l.returned)} {l.unit} returned
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-xs">Accepted</Label>
                <MoneyInput
                  min={0}
                  value={l.accepted || 0}
                  onChange={(v) => patch(i, { accepted: v })}
                />
              </div>
              <div>
                <Label className="text-xs">Damaged</Label>
                <MoneyInput
                  min={0}
                  value={l.damaged || 0}
                  onChange={(v) => patch(i, { damaged: v })}
                />
              </div>
              <div>
                <Label className="text-xs">Rejected</Label>
                <MoneyInput
                  min={0}
                  value={l.rejected || 0}
                  onChange={(v) => patch(i, { rejected: v })}
                />
              </div>
            </div>
            {(l.damaged > 0 || l.rejected > 0) && (
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={l.charge_rep}
                  onCheckedChange={(v) => patch(i, { charge_rep: !!v })}
                />
                Charge the rep for the damaged / rejected value (uncheck to write it off to the
                company)
              </label>
            )}
          </div>
        ))}
        <div>
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Complete inspection
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelReturnDialog({ row, onDone }: { row: ReturnRow; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const run = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_rep_return", {
        p_id: row.id,
        p_reason: reason.trim() || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Return cancelled — goods returned to van stock");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Cancel {row.return_number}</DialogTitle>
      </DialogHeader>
      <div>
        <Label>Reason</Label>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="destructive" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Cancel return
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ----------------------------------------------------------- Remittances --- */

function RemittancesTab({
  factoryId,
  reps,
  perms,
}: {
  factoryId: string;
  reps: Rep[];
  perms: Perms;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const canPost = perms.canPost("distribution");

  const list = useQuery({
    queryKey: ["dist-remittances", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_remittances")
        .select(
          "id,remittance_number,remittance_date,amount,payment_method,remarks,sales_reps(full_name)",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as RemittanceRow[];
    },
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Remittances</CardTitle>
        {canPost && (
          <Button size="sm" className="gap-2" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Record Remittance
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Remittance #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Rep</TableHead>
              <TableHead>Method</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.remittance_number}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {new Date(r.remittance_date).toLocaleDateString()}
                </TableCell>
                <TableCell className="font-medium">{r.sales_reps?.full_name ?? "—"}</TableCell>
                <TableCell className="capitalize">{r.payment_method}</TableCell>
                <TableCell className="text-right">{money(Number(r.amount))}</TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No remittances recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <RemittanceDialog
            factoryId={factoryId}
            reps={reps}
            onDone={() => {
              setOpen(false);
              qc.invalidateQueries({ queryKey: ["dist-remittances"] });
              qc.invalidateQueries({ queryKey: ["dist-account"] });
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

// Also opened from the Accountant page's Postings tab, preset to the marketer
// or outlet of the dispatch being paid for.
export function RemittanceDialog({
  factoryId,
  reps,
  presetRepId = "",
  presetRemarks = "",
  onDone,
}: {
  factoryId: string;
  reps: Rep[];
  presetRepId?: string;
  presetRemarks?: string;
  onDone: () => void;
}) {
  const [repId, setRepId] = useState(presetRepId);
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState(presetRemarks);

  const submit = useMutation({
    mutationFn: async () => {
      if (!repId) throw new Error("Select a sales rep");
      if (amount <= 0) throw new Error("Amount must be > 0");
      const { data, error } = await supabase.rpc("record_rep_remittance", {
        payload: {
          factory_id: factoryId,
          sales_rep_id: repId,
          amount,
          payment_method: method,
          remittance_date: date,
          remarks: remarks || undefined,
        } as never,
      });
      if (error) throw error;
      return data as { remittance_number?: string; id?: string };
    },
    onSuccess: (data) => {
      toast.success(`Remittance ${data?.remittance_number ?? ""} recorded`);
      logAudit({ action: "payment", entity: "rep_remittances", entityId: data?.id, factoryId });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Record Remittance</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Rep / outlet</Label>
          <Select value={repId} onValueChange={setRepId}>
            <SelectTrigger>
              <SelectValue placeholder="Select rep or outlet…" />
            </SelectTrigger>
            <SelectContent>
              {reps.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {repLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} />
          </div>
          <div>
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["cash", "transfer", "pos", "card", "cheque"].map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Record
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* -------------------------------------------------------------- Accounts --- */

type AccountSummary = {
  goods_out_value: number;
  accepted_returns_value: number;
  accepted_only_value: number;
  written_off_value: number;
  damaged_value: number;
  rejected_value: number;
  cash_remitted: number;
  credit_outstanding: number;
  credit_collected: number;
  van_stock_value: number;
  sales_count: number;
  sales_value: number;
  net_balance_owed: number;
};

// Marketer & retail accounts: one rep's or outlet's account at a time. Shown
// on the Accountant page (Accounting's, not the Warehouse's).
export function AccountsTab({
  factoryId,
  reps,
  perms,
}: {
  factoryId: string;
  reps: Rep[];
  perms: Perms;
}) {
  const [repId, setRepId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="min-w-48">
            <Label>Rep / outlet</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Select rep or outlet…" />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {repLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label>To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {!repId && <p className="text-sm text-muted-foreground">Pick a rep to see their account.</p>}

      {repId && (
        <RepAccountView
          factoryId={factoryId}
          repId={repId}
          repName={reps.find((r) => r.id === repId)?.full_name ?? "rep"}
          perms={perms}
          from={from}
          to={to}
        />
      )}
    </div>
  );
}

// Everything that happened on one marketer's (or the shop's) account, newest
// first: dispatches to them, their returns, their sales and the cash they
// remitted. Values show only to whoever may see that account.
type RepActivity = {
  key: string;
  date: string;
  kind: "Dispatch" | "Return" | "Sale" | "Cash remitted";
  reference: string;
  status: string;
  value: number;
};

function RepActivityCard({ repId, showValues }: { repId: string; showValues: boolean }) {
  const activity = useQuery({
    queryKey: ["dist-rep-activity", repId],
    queryFn: async () => {
      const [dispatches, returns, sales, remits] = await Promise.all([
        supabase
          .from("stock_dispatches")
          .select("id,dispatch_number,dispatch_date,created_at,status,total_value")
          .eq("sales_rep_id", repId)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("rep_returns")
          .select(
            "id,return_number,return_date,received_at,status,rep_return_items(quantity_returned,unit_price)",
          )
          .eq("sales_rep_id", repId)
          .order("received_at", { ascending: false })
          .limit(100),
        supabase
          .from("sales")
          .select("id,invoice_number,sale_date,created_at,status,grand_total,is_pr")
          .eq("sales_rep_id", repId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("rep_remittances")
          .select("id,remittance_number,remittance_date,created_at,amount")
          .eq("sales_rep_id", repId)
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
      for (const r of [dispatches, returns, sales, remits]) if (r.error) throw r.error;
      const rows: RepActivity[] = [
        ...(dispatches.data ?? []).map((d) => ({
          key: `d-${d.id}`,
          date: d.created_at ?? d.dispatch_date,
          kind: "Dispatch" as const,
          reference: d.dispatch_number,
          status: d.status,
          value: Number(d.total_value ?? 0),
        })),
        ...(
          (returns.data ?? []) as unknown as {
            id: string;
            return_number: string;
            return_date: string;
            received_at: string | null;
            status: string;
            rep_return_items: { quantity_returned: number; unit_price: number }[];
          }[]
        ).map((r) => ({
          key: `r-${r.id}`,
          date: r.received_at ?? r.return_date,
          kind: "Return" as const,
          reference: r.return_number,
          status: r.status,
          value: r.rep_return_items.reduce(
            (t, i) => t + Number(i.quantity_returned) * Number(i.unit_price),
            0,
          ),
        })),
        ...(sales.data ?? []).map((s) => ({
          key: `s-${s.id}`,
          date: s.created_at ?? s.sale_date,
          kind: "Sale" as const,
          reference: s.invoice_number,
          status: s.is_pr ? "PR" : String(s.status),
          value: Number(s.grand_total ?? 0),
        })),
        ...(remits.data ?? []).map((m) => ({
          key: `m-${m.id}`,
          date: m.created_at ?? m.remittance_date,
          kind: "Cash remitted" as const,
          reference: m.remittance_number,
          status: "received",
          value: Number(m.amount ?? 0),
        })),
      ];
      return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    },
  });
  const rows = (activity.data ?? []).filter((r) => showValues || r.kind !== "Cash remitted");

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>All activity</CardTitle>
      </CardHeader>
      <CardContent className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Activity</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Status</TableHead>
              {showValues && <TableHead className="text-right">Value</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="whitespace-nowrap text-xs">
                  {new Date(r.date).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{r.kind}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                <TableCell className="text-xs capitalize">{r.status.replace(/_/g, " ")}</TableCell>
                {showValues && <TableCell className="text-right">{money(r.value)}</TableCell>}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={showValues ? 5 : 4}
                  className="py-6 text-center text-muted-foreground"
                >
                  {activity.isLoading
                    ? "Loading…"
                    : activity.isError
                      ? "Couldn't load the activity."
                      : "No activity yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// A marketer's (or the shop's) full details, opened by clicking their row on
// Reps & Outlets or picking them from the top search. Whoever may see the
// account (Finance/Payments/Debts, or Marketer & Retail Accounts) gets the
// account and its values; anyone else gets stock and activity only.
export function RepDetailsDialog({ factoryId, rep }: { factoryId: string; rep: Rep }) {
  const perms = usePermissions();
  const canAccount = perms.canSeeMoney || perms.can("marketer-accounts");
  return (
    <DialogContent className="max-h-[92vh] w-[95vw] max-w-5xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          {rep.full_name}
          <Badge variant="outline" className="font-normal">
            {rep.kind === "outlet" ? "Retail outlet" : "Marketer"}
          </Badge>
          {rep.code && <span className="font-mono text-xs text-muted-foreground">{rep.code}</span>}
          {rep.phone && (
            <span className="text-sm font-normal text-muted-foreground">{rep.phone}</span>
          )}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        {canAccount ? (
          <RepAccountView
            factoryId={factoryId}
            repId={rep.id}
            repName={rep.full_name}
            perms={perms}
          />
        ) : (
          <RepStockView repId={rep.id} />
        )}
        <RepActivityCard repId={rep.id} showValues={canAccount} />
      </div>
    </DialogContent>
  );
}

// One rep's (marketer's) account: balance and reconciliation, the customers/
// offices under them (RepCustomersCard: what each owes, invoices, collecting
// payments), and van stock. Used by Distribution → Accounts and by the
// Warehouse "Post → Marketers" dialog.
function RepAccountView({
  factoryId,
  repId,
  repName,
  perms,
  from = "",
  to = "",
}: {
  factoryId: string;
  repId: string;
  repName: string;
  perms: Perms;
  from?: string;
  to?: string;
}) {
  const summary = useQuery({
    queryKey: ["dist-account", repId, from, to],
    enabled: !!repId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("rep_account_summary", {
        p_sales_rep_id: repId,
        p_from: from || undefined,
        p_to: to || undefined,
      });
      if (error) throw error;
      return data as unknown as AccountSummary;
    },
  });

  const vanStock = useQuery({
    queryKey: ["dist-rep-stock", repId, "van-table"],
    enabled: !!repId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock")
        .select("quantity,products(name,unit,unit_price)")
        .eq("sales_rep_id", repId)
        .gt("quantity", 0);
      if (error) throw error;
      return (data ?? []) as unknown as {
        quantity: number;
        products: { name: string; unit: string; unit_price: number } | null;
      }[];
    },
  });

  const s = summary.data;
  const rows: { label: string; value: number; strong?: boolean }[] = s
    ? [
        { label: "Goods out (dispatched value)", value: s.goods_out_value },
        { label: "Less: accepted returns", value: -s.accepted_only_value },
        { label: "Less: damage/rejects written off", value: -s.written_off_value },
        { label: "Less: cash remitted", value: -s.cash_remitted },
        { label: "Less: customer credit outstanding", value: -s.credit_outstanding },
        {
          label: "Less: customer payments received on rep credit",
          value: -(s.credit_collected ?? 0),
        },
        { label: "Balance owed by rep", value: s.net_balance_owed, strong: true },
      ]
    : [];

  if (summary.isLoading)
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );

  return (
    <div className="space-y-4">
      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Sales booked" value={`${s.sales_count} · ${money(s.sales_value)}`} />
            <Stat label="Cash remitted" value={money(s.cash_remitted)} />
            <Stat label="Credit outstanding" value={money(s.credit_outstanding)} />
            <Stat
              label="Balance owed by rep"
              value={money(s.net_balance_owed)}
              tone={s.net_balance_owed > 0 ? "warn" : "ok"}
            />
          </div>

          <Card className="rounded-2xl">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle>Account reconciliation</CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() =>
                  exportCsv(
                    `rep-account-${repName}`,
                    [
                      { key: "label", label: "Line" },
                      { key: "value", label: "Amount" },
                    ],
                    rows.map((r) => ({ label: r.label, value: r.value })),
                  )
                }
              >
                <FileDown className="h-4 w-4" /> CSV
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.label}>
                      <TableCell className={r.strong ? "font-semibold" : ""}>{r.label}</TableCell>
                      <TableCell
                        className={`text-right ${r.strong ? "font-semibold" : ""} ${
                          r.value < 0 ? "text-muted-foreground" : ""
                        }`}
                      >
                        {money(r.value)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">
                Damaged value in period: {money(s.damaged_value)} · Rejected:{" "}
                {money(s.rejected_value)} · Van stock at cost-of-sale price:{" "}
                {money(s.van_stock_value)}
              </p>
            </CardContent>
          </Card>

          <RepPerformanceCard factoryId={factoryId} repId={repId} from={from} to={to} />

          <RepCustomersCard
            factoryId={factoryId}
            canCollect={perms.canWrite("payments") || perms.canWrite("debts")}
            repId={repId}
            repName={repName}
            from={from}
            to={to}
          />

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Van stock on hand</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(vanStock.data ?? []).map((v, i) => (
                    <TableRow key={i}>
                      <TableCell>{v.products?.name ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {num(Number(v.quantity))} {v.products?.unit}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(Number(v.quantity) * Number(v.products?.unit_price ?? 0))}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(vanStock.data ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                        No van stock.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

type PerfRow = {
  sales_rep_id: string;
  sales_count: number;
  units_sold: number;
  sales_value: number;
  commission_earned: number;
  units_returned: number;
  commission_reversed: number;
  net_commission: number;
};

// This marketer's line of Performance & Commission (marketer_performance):
// what they sold in the period and the commission earned — a fixed amount per
// unit, less units customers returned. With no dates picked on the account it
// covers the current month (the RPC needs a range).
function RepPerformanceCard({
  factoryId,
  repId,
  from,
  to,
}: {
  factoryId: string;
  repId: string;
  from: string;
  to: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const pFrom = from || `${today.slice(0, 8)}01`;
  const pTo = to || today;
  const perf = useQuery({
    queryKey: ["marketer-performance", factoryId, pFrom, pTo],
    enabled: pFrom <= pTo,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("marketer_performance", {
        p_factory: factoryId,
        p_from: pFrom,
        p_to: pTo,
      });
      if (error) throw error;
      return (data ?? []) as PerfRow[];
    },
  });
  const r = (perf.data ?? []).find((x) => x.sales_rep_id === repId);

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Performance &amp; Commission</CardTitle>
        <p className="text-sm text-muted-foreground">
          What this marketer sold from {new Date(pFrom).toLocaleDateString()} to{" "}
          {new Date(pTo).toLocaleDateString()}
          {!from && !to && " (this month — pick dates above to change)"} and the commission earned:
          a fixed amount per unit, less units customers returned.
        </p>
      </CardHeader>
      <CardContent>
        {perf.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Sales · units sold"
              value={`${r?.sales_count ?? 0} · ${num(Number(r?.units_sold ?? 0))}`}
            />
            <Stat label="Sales value" value={money(Number(r?.sales_value ?? 0))} />
            <Stat label="Commission earned" value={money(Number(r?.commission_earned ?? 0))} />
            <Stat
              label="Units returned (commission off)"
              value={`${num(Number(r?.units_returned ?? 0))} · −${money(Number(r?.commission_reversed ?? 0))}`}
            />
            <Stat
              label="Net commission due"
              value={money(Number(r?.net_commission ?? 0))}
              tone="ok"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={`mt-1 text-lg font-semibold ${
            tone === "warn" ? "text-destructive" : tone === "ok" ? "text-emerald-600" : ""
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

type RepInvoice = {
  sale_id: string;
  invoice_number: string;
  sale_date: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  grand_total: number;
  cash_paid: number;
  advance_applied: number;
  written_off: number;
  outstanding: number;
  due_date: string | null;
  paid_at: string | null;
  debt_status: string | null;
  sold_by_rep: boolean;
};

type RepCustomer = {
  customer_id: string;
  name: string;
  phone: string | null;
  assigned: boolean;
  total_owed: number;
  advance_balance: number;
  collected_by_rep: number;
  last_collection: string | null;
};

type CustomerRow = {
  key: string;
  customerId: string | null;
  name: string;
  phone: string | null;
  walkIn: boolean;
  assigned: boolean;
  account: RepCustomer | null;
  invoices: RepInvoice[];
  goods: number;
  paid: number;
  owes: number;
  overdue: number;
  last: string | null;
};

// The marketer's customers: everyone assigned to them (Customers -> Marketer)
// plus everyone they sold to. Per customer: goods taken, paid (cash at the
// sale, later payments, advance drawn), still owed and overdue in the period,
// and what the marketer has collected from them. Invoices of an assigned
// customer that someone else sold are listed too, since this marketer
// collects on them. "Record payment" records money the marketer brought in
// from the customer (record_payment with collected_by_rep): it settles the
// customer's oldest debts first and counts toward the marketer's account, so
// it is not also entered as a remittance.
function RepCustomersCard({
  factoryId,
  repId,
  repName,
  from,
  to,
  canCollect,
}: {
  factoryId: string;
  repId: string;
  repName: string;
  from: string;
  to: string;
  canCollect: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [owingOnly, setOwingOnly] = useState(false);
  const [paying, setPaying] = useState<CustomerRow | null>(null);

  const invoices = useQuery({
    queryKey: ["dist-rep-customers", repId, from, to],
    enabled: !!repId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("rep_customer_invoices", {
        p_sales_rep_id: repId,
        p_from: from || undefined,
        p_to: to || undefined,
      });
      if (error) throw error;
      return (data ?? []) as RepInvoice[];
    },
  });
  const accounts = useQuery({
    queryKey: ["dist-rep-customer-accounts", repId],
    enabled: !!repId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("rep_customers", { p_sales_rep_id: repId });
      if (error) throw error;
      return (data ?? []) as RepCustomer[];
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const overdueOf = (r: RepInvoice) =>
    Number(r.outstanding) > 0 && r.due_date && r.due_date < today ? Number(r.outstanding) : 0;

  const customers = useMemo(() => {
    const map = new Map<string, CustomerRow>();
    for (const a of accounts.data ?? []) {
      map.set(a.customer_id, {
        key: a.customer_id,
        customerId: a.customer_id,
        name: a.name,
        phone: a.phone,
        walkIn: false,
        assigned: a.assigned,
        account: a,
        invoices: [],
        goods: 0,
        paid: 0,
        owes: 0,
        overdue: 0,
        last: null,
      });
    }
    for (const r of invoices.data ?? []) {
      const key = r.customer_id ?? `walk-in:${r.customer_name.toLowerCase()}`;
      const c = map.get(key) ?? {
        key,
        customerId: r.customer_id,
        name: r.customer_name,
        phone: r.customer_phone,
        walkIn: !r.customer_id,
        assigned: false,
        account: null,
        invoices: [],
        goods: 0,
        paid: 0,
        owes: 0,
        overdue: 0,
        last: null,
      };
      c.invoices.push(r);
      c.goods += Number(r.grand_total);
      c.paid += Number(r.cash_paid) + Number(r.advance_applied);
      c.owes += Number(r.outstanding);
      c.overdue += overdueOf(r);
      if (!c.last || r.sale_date > c.last) c.last = r.sale_date;
      map.set(key, c);
    }
    return [...map.values()]
      .filter((c) => !owingOnly || c.owes > 0 || Number(c.account?.total_owed ?? 0) > 0)
      .sort((a, b) => b.owes - a.owes || b.goods - a.goods || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices.data, accounts.data, owingOnly]);

  const totals = customers.reduce(
    (t, c) => ({
      goods: t.goods + c.goods,
      paid: t.paid + c.paid,
      owes: t.owes + c.owes,
      overdue: t.overdue + c.overdue,
      collected: t.collected + Number(c.account?.collected_by_rep ?? 0),
    }),
    { goods: 0, paid: 0, owes: 0, overdue: 0, collected: 0 },
  );

  const exportRows = () =>
    exportCsv(
      `rep-customers-${repName}`,
      [
        { key: "customer", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "assigned", label: "Assigned" },
        { key: "invoice", label: "Invoice" },
        { key: "sold_by", label: "Sold by" },
        { key: "date", label: "Date" },
        { key: "goods", label: "Goods taken" },
        { key: "paid", label: "Paid" },
        { key: "advance", label: "From advance" },
        { key: "written_off", label: "Written off" },
        { key: "owes", label: "Owes" },
        { key: "due", label: "Due date" },
      ],
      customers.flatMap((c) =>
        c.invoices.map((r) => ({
          customer: c.name,
          phone: c.phone ?? "",
          assigned: c.assigned ? "Yes" : "",
          invoice: r.invoice_number,
          sold_by: r.sold_by_rep ? repName : "Warehouse / other",
          date: r.sale_date,
          goods: Number(r.grand_total),
          paid: Number(r.cash_paid),
          advance: Number(r.advance_applied),
          written_off: Number(r.written_off),
          owes: Number(r.outstanding),
          due: r.due_date ?? "",
        })),
      ),
    );

  const statusOf = (r: RepInvoice) =>
    Number(r.written_off) > 0
      ? "Written off"
      : Number(r.outstanding) <= 0
        ? "Paid"
        : overdueOf(r) > 0
          ? "Overdue"
          : Number(r.cash_paid) + Number(r.advance_applied) > 0
            ? "Part paid"
            : "Unpaid";

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Customers of {repName}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {customers.length} customer(s) · goods {money(totals.goods)} · paid {money(totals.paid)}{" "}
            ·{" "}
            <span className={totals.owes > 0 ? "font-medium text-destructive" : ""}>
              owing {money(totals.owes)}
            </span>
            {totals.overdue > 0 && (
              <span className="text-destructive"> ({money(totals.overdue)} overdue)</span>
            )}{" "}
            · collected by {repName}: {money(totals.collected)}. Click a customer for their
            invoices.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={owingOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setOwingOnly((v) => !v)}
          >
            Owing only
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={!customers.length}
            onClick={exportRows}
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Customer</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="text-right">Invoices</TableHead>
              <TableHead className="text-right">Goods taken</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Owes</TableHead>
              <TableHead className="text-right">Overdue</TableHead>
              <TableHead className="text-right">Collected by rep</TableHead>
              <TableHead>Last purchase</TableHead>
              {canCollect && <TableHead className="w-32" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={canCollect ? 11 : 10}
                  className="py-8 text-center text-muted-foreground"
                >
                  {invoices.isLoading || accounts.isLoading
                    ? "Loading…"
                    : owingOnly
                      ? "None of this marketer's customers owes anything."
                      : "No customers yet. Assign customers to this marketer on the Customers page."}
                </TableCell>
              </TableRow>
            )}
            {customers.map((c) => {
              const expanded = open === c.key;
              return (
                <Fragment key={c.key}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setOpen(expanded ? null : c.key)}
                  >
                    <TableCell>
                      {expanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      {c.name}
                      {c.assigned && (
                        <Badge variant="secondary" className="ml-2">
                          assigned
                        </Badge>
                      )}
                      {c.walkIn && (
                        <Badge variant="outline" className="ml-2 text-muted-foreground">
                          walk-in
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{c.phone ?? "—"}</TableCell>
                    <TableCell className="text-right">{c.invoices.length}</TableCell>
                    <TableCell className="text-right">{money(c.goods)}</TableCell>
                    <TableCell className="text-right">{money(c.paid)}</TableCell>
                    <TableCell
                      className={`text-right font-semibold ${c.owes > 0 ? "text-destructive" : ""}`}
                    >
                      {c.owes > 0 ? money(c.owes) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-destructive">
                      {c.overdue > 0 ? money(c.overdue) : ""}
                    </TableCell>
                    <TableCell className="text-right">
                      {Number(c.account?.collected_by_rep ?? 0) > 0
                        ? money(Number(c.account!.collected_by_rep))
                        : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {c.last ? new Date(c.last).toLocaleDateString() : "—"}
                    </TableCell>
                    {canCollect && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {c.customerId && (
                          <Button size="sm" variant="outline" onClick={() => setPaying(c)}>
                            Record payment
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                  {expanded && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={canCollect ? 10 : 9}>
                        {c.account && (
                          <p className="mb-2 text-xs text-muted-foreground">
                            Whole account: owes {money(Number(c.account.total_owed))} · advance{" "}
                            {money(Number(c.account.advance_balance))} · collected by {repName}{" "}
                            {money(Number(c.account.collected_by_rep))}
                            {c.account.last_collection &&
                              ` (last ${new Date(c.account.last_collection).toLocaleDateString()})`}
                          </p>
                        )}
                        {c.invoices.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No invoices in this period.
                          </p>
                        ) : (
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Invoice</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead className="text-right">Goods</TableHead>
                                <TableHead className="text-right">Paid</TableHead>
                                <TableHead className="text-right">From advance</TableHead>
                                <TableHead className="text-right">Owes</TableHead>
                                <TableHead>Due</TableHead>
                                <TableHead>Status</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {c.invoices.map((r) => {
                                const status = statusOf(r);
                                return (
                                  <TableRow key={r.sale_id}>
                                    <TableCell className="font-mono text-xs">
                                      {r.invoice_number}
                                      {!r.sold_by_rep && (
                                        <Badge
                                          variant="outline"
                                          className="ml-2 font-sans text-muted-foreground"
                                        >
                                          sold by warehouse
                                        </Badge>
                                      )}
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap">
                                      {new Date(r.sale_date).toLocaleDateString()}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {money(Number(r.grand_total))}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {money(Number(r.cash_paid))}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {Number(r.advance_applied) > 0
                                        ? money(Number(r.advance_applied))
                                        : "—"}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {Number(r.outstanding) > 0
                                        ? money(Number(r.outstanding))
                                        : "—"}
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap">
                                      {r.due_date ? new Date(r.due_date).toLocaleDateString() : "—"}
                                    </TableCell>
                                    <TableCell>
                                      <Badge
                                        variant={
                                          status === "Overdue" || status === "Unpaid"
                                            ? "destructive"
                                            : status === "Paid"
                                              ? "secondary"
                                              : "outline"
                                        }
                                      >
                                        {status}
                                      </Badge>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={!!paying} onOpenChange={(v) => !v && setPaying(null)}>
        {paying?.customerId && (
          <CollectPaymentDialog
            factoryId={factoryId}
            repId={repId}
            repName={repName}
            customerId={paying.customerId}
            customerName={paying.name}
            owed={Number(paying.account?.total_owed ?? paying.owes)}
            onDone={() => setPaying(null)}
          />
        )}
      </Dialog>
    </Card>
  );
}

const COLLECT_METHODS = ["cash", "transfer", "pos", "card", "cheque"] as const;

// Money the marketer brought in from one of their customers. Recorded as a
// customer payment (settles the oldest debts first; anything over what is
// owed becomes the customer's advance) and credited to the marketer.
function CollectPaymentDialog({
  factoryId,
  repId,
  repName,
  customerId,
  customerName,
  owed,
  onDone,
}: {
  factoryId: string;
  repId: string;
  repName: string;
  customerId: string;
  customerName: string;
  owed: number;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(owed > 0 ? String(owed) : "");
  const [method, setMethod] = useState<(typeof COLLECT_METHODS)[number]>("cash");
  const [remarks, setRemarks] = useState("");
  // One key per dialog: a double-click replays the first result.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const value = Number(amount);

  const save = useMutation({
    mutationFn: async () => {
      if (!(value > 0)) throw new Error("Enter the amount collected");
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: customerId,
          amount: value,
          payment_method: method,
          remarks: remarks.trim() || `Collected by ${repName}`,
          collected_by_rep: repId,
          idempotency_key: idempotencyKey,
        },
      });
      if (error) throw error;
      return data as { receipt_number?: string; settled_debt?: number; credit_added?: number };
    },
    onSuccess: (res) => {
      const extra = Number(res?.credit_added ?? 0);
      toast.success(
        `Receipt ${res?.receipt_number ?? ""} recorded${extra > 0 ? ` — ${money(extra)} kept as advance` : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["dist-rep-customers"] });
      qc.invalidateQueries({ queryKey: ["dist-rep-customer-accounts"] });
      qc.invalidateQueries({ queryKey: ["dist-account"] });
      qc.invalidateQueries({ queryKey: ["credit-sales"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Payment from {customerName}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Collected by {repName}. {customerName} owes {money(owed)} in total. The payment clears
          their oldest debts first; anything more is kept as their advance.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <Label>Method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLLECT_METHODS.map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Remarks</Label>
          <Input
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder={`Collected by ${repName}`}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          This counts toward {repName}&apos;s account, so don&apos;t also record it as a remittance.
        </p>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending || !(value > 0)} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Record payment"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
