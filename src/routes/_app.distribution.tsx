import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useMemo, useState } from "react";
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
import { Plus, Trash2, Pencil, Undo2, Ban, Eye, Loader2, Send, FileDown } from "lucide-react";
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";

export const Route = createFileRoute("/_app/distribution")({
  head: () => ({
    meta: [{ title: "Distribution — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="distribution">
      <DistributionPage />
    </RequireAccess>
  ),
});

type Rep = {
  id: string;
  code: string | null;
  full_name: string;
  phone: string | null;
  status: string;
  employee_id: string | null;
  remarks: string | null;
};
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
  sales_reps: { full_name: string } | null;
  rep_return_items: {
    id: string;
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
        .select("id,code,full_name,phone,status,employee_id,remarks")
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
          Every product leaves the store on a dispatch to a sales rep. The rep sells from van stock,
          returns what's unsold for inspection, and remits cash — their account nets it all against
          the value of goods they took.
        </p>
      </div>

      <Tabs defaultValue="reps">
        <TabsList className="flex-wrap">
          <TabsTrigger value="reps">Sales Reps</TabsTrigger>
          <TabsTrigger value="dispatches">Dispatches</TabsTrigger>
          <TabsTrigger value="returns">Rep Returns</TabsTrigger>
          <TabsTrigger value="remittances">Remittances</TabsTrigger>
          <TabsTrigger value="accounts">Rep Accounts</TabsTrigger>
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
        <TabsContent value="accounts" className="mt-4">
          <AccountsTab factoryId={factoryId} reps={reps.data ?? []} />
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
        <CardTitle>Sales Reps</CardTitle>
        {canCreate && (
          <Button
            size="sm"
            className="gap-2"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Add Rep
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reps.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.code ?? "—"}</TableCell>
                <TableCell className="font-medium">{r.full_name}</TableCell>
                <TableCell>{r.phone ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={r.status === "active" ? "secondary" : "outline"}>
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell>
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
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No sales reps yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

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
  const [code, setCode] = useState(rep?.code ?? "");
  const [phone, setPhone] = useState(rep?.phone ?? "");
  const [status, setStatus] = useState(rep?.status ?? "active");
  const [remarks, setRemarks] = useState(rep?.remarks ?? "");

  const save = useMutation({
    mutationFn: async () => {
      if (!fullName.trim()) throw new Error("Name is required");
      const body = {
        factory_id: factoryId,
        full_name: fullName.trim(),
        code: code.trim() || null,
        phone: phone.trim() || null,
        status,
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
      toast.success(rep ? "Rep updated" : "Rep added");
      logAudit({ action: rep ? "update" : "create", entity: "sales_reps", factoryId });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{rep ? "Edit Sales Rep" : "Add Sales Rep"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Full name</Label>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Code</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="SR-01" />
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
}: {
  products: Product[];
  lines: Line[];
  setLines: (l: Line[]) => void;
  stockOf: (productId: string) => number;
  qtyLabel?: string;
}) {
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
              <Select value={l.product_id} onValueChange={(v) => update(i, { product_id: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
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
}: {
  factoryId: string;
  reps: Rep[];
  products: Product[];
  vehicles: NamedRow[];
  drivers: NamedRow[];
  routes: NamedRow[];
  onDone: () => void;
}) {
  const [repId, setRepId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [vehicleId, setVehicleId] = useState("none");
  const [driverId, setDriverId] = useState("none");
  const [routeId, setRouteId] = useState("none");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ product_id: "", quantity: 0 }]);

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
      if (!repId) throw new Error("Select a sales rep");
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

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>New Dispatch — store → rep</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Sales rep</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Select rep…" />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
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
          <Label>Products (store stock shown in brackets)</Label>
          <LineEditor
            products={products}
            lines={lines}
            setLines={setLines}
            stockOf={(id) => products.find((p) => p.id === id)?.current_stock ?? 0}
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
        store.
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

function ReturnsTab({
  factoryId,
  reps,
  products,
  perms,
  currentUserId,
}: {
  factoryId: string;
  reps: Rep[];
  products: Product[];
  perms: Perms;
  currentUserId: string | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<ReturnRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReturnRow | null>(null);
  const canSubmit = perms.canSubmit("distribution");
  const canConfirm = perms.canConfirm("distribution");
  const canCancel = perms.canCancel("distribution");

  const list = useQuery({
    queryKey: ["dist-returns", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_returns")
        .select(
          "id,return_number,return_date,status,received_by,notes,sales_reps(full_name),rep_return_items(id,quantity_returned,unit_price,accepted_quantity,damaged_quantity,rejected_quantity,charge_rep,products(name,unit))",
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
        <CardTitle>Rep Returns</CardTitle>
        {canSubmit && (
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
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
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
      toast.success(`Return ${data?.return_number ?? ""} logged — awaiting inspection`);
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
            <Label>Sales rep</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Select rep…" />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
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
      toast.success("Return inspected — accepted stock posted to store");
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

function RemittanceDialog({
  factoryId,
  reps,
  onDone,
}: {
  factoryId: string;
  reps: Rep[];
  onDone: () => void;
}) {
  const [repId, setRepId] = useState("");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState("");

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
          <Label>Sales rep</Label>
          <Select value={repId} onValueChange={setRepId}>
            <SelectTrigger>
              <SelectValue placeholder="Select rep…" />
            </SelectTrigger>
            <SelectContent>
              {reps.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.full_name}
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
  van_stock_value: number;
  sales_count: number;
  sales_value: number;
  net_balance_owed: number;
};

function AccountsTab({ factoryId, reps }: { factoryId: string; reps: Rep[] }) {
  const [repId, setRepId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

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
        { label: "Balance owed by rep", value: s.net_balance_owed, strong: true },
      ]
    : [];

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="min-w-48">
            <Label>Sales rep</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Select rep…" />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
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
          {s && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() =>
                exportCsv(
                  `rep-account-${reps.find((r) => r.id === repId)?.full_name ?? repId}`,
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
          )}
        </CardContent>
      </Card>

      {!repId && <p className="text-sm text-muted-foreground">Pick a rep to see their account.</p>}

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
            <CardHeader>
              <CardTitle>Account reconciliation</CardTitle>
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
