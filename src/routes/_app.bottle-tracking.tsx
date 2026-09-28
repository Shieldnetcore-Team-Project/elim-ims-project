import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { num } from "@/lib/format";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { toast } from "sonner";
import { ArrowLeftRight, Plus, Search } from "lucide-react";

// Returnable containers (bottles, crates, dispensers): where every one is.
// Sales, dispatches to marketers and returns move them automatically; this
// page records the rest by hand -- empties brought back, containers issued,
// lost, damaged or bought in (20260928140000_container_tracking.sql).
export const Route = createFileRoute("/_app/bottle-tracking")({
  head: () => ({
    meta: [{ title: "Bottle Tracking — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="distribution">
        <BottleTrackingPage />
      </RequireAccess>
    </>
  ),
});

type HolderType = "warehouse" | "customer" | "sales_rep" | "walk_in" | "external";
type ContainerType = { id: string; name: string; active: boolean };
type Balance = {
  container_type_id: string;
  holder_type: HolderType;
  holder_id: string | null;
  balance: number;
};
type Movement = {
  id: string;
  created_at: string;
  container_type_id: string;
  from_type: HolderType;
  from_id: string | null;
  to_type: HolderType;
  to_id: string | null;
  quantity: number;
  source: string;
  reference: string | null;
  notes: string | null;
};
type Named = { id: string; name: string };

const SOURCE_LABELS: Record<string, string> = {
  dispatch: "Dispatch to marketer",
  dispatch_reversal: "Dispatch reversed",
  sale: "Sale",
  sale_reversal: "Sale deleted",
  rep_return: "Marketer returned stock",
  rep_return_cancelled: "Marketer return cancelled",
  sales_return: "Customer returned product",
  sales_return_cancelled: "Customer return cancelled",
  return: "Empties returned",
  issue: "Issued",
  lost: "Lost (written off)",
  purchase: "Bought in",
  damaged: "Damaged (written off)",
};

function BottleTrackingPage() {
  const { data: factoryId } = useFactoryId();
  const { canCreate, canApprove } = usePermissions();
  const canRecord = canCreate("distribution");
  const canManage = canApprove("distribution");
  const [recordOpen, setRecordOpen] = useState(false);
  const [holderFilter, setHolderFilter] = useState<"all" | "customer" | "sales_rep">("all");
  const [q, setQ] = useState("");

  useRealtimeInvalidate(
    ["container_movements", "container_types", "product_containers"],
    [["container-balances"], ["container-movements"], ["container-types"], ["product-containers"]],
  );

  const types = useQuery({
    queryKey: ["container-types", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("container_types")
        .select("id,name,active")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as ContainerType[];
    },
  });

  const balances = useQuery({
    queryKey: ["container-balances", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      // A view, so not in the generated types.
      const { data, error } = await (supabase as any)
        .from("container_balances")
        .select("container_type_id,holder_type,holder_id,balance")
        .eq("factory_id", factoryId!);
      if (error) throw error;
      return (data ?? []) as Balance[];
    },
  });

  const movements = useQuery({
    queryKey: ["container-movements", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("container_movements")
        .select(
          "id,created_at,container_type_id,from_type,from_id,to_type,to_id,quantity,source,reference,notes",
        )
        .eq("factory_id", factoryId!)
        .order("seq", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Movement[];
    },
  });

  const customers = useQuery({
    queryKey: ["container-holder-customers", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      return (data ?? []) as Named[];
    },
  });
  const reps = useQuery({
    queryKey: ["container-holder-reps", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data } = await supabase
        .from("sales_reps")
        .select("id,full_name")
        .eq("factory_id", factoryId!)
        .order("full_name");
      return (data ?? []).map((r) => ({ id: r.id, name: r.full_name })) as Named[];
    },
  });

  const typeList = types.data ?? [];
  const typeName = (id: string) => typeList.find((t) => t.id === id)?.name ?? "Container";
  const holderName = (type: HolderType, id: string | null) => {
    if (type === "warehouse") return "Warehouse";
    if (type === "walk_in") return "Walk-in sales";
    if (type === "external") return "Outside (bought / written off)";
    const list = type === "customer" ? customers.data : reps.data;
    return list?.find((x) => x.id === id)?.name ?? (type === "customer" ? "Customer" : "Marketer");
  };

  // Where each container type is: warehouse / customers / marketers / walk-in.
  const summary = useMemo(() => {
    const out = new Map<string, Record<string, number>>();
    for (const b of balances.data ?? []) {
      const row = out.get(b.container_type_id) ?? {};
      row[b.holder_type] = (row[b.holder_type] ?? 0) + Number(b.balance);
      out.set(b.container_type_id, row);
    }
    return out;
  }, [balances.data]);

  // Per customer / marketer, one column per container type.
  const holders = useMemo(() => {
    const map = new Map<string, { type: HolderType; id: string; counts: Record<string, number> }>();
    for (const b of balances.data ?? []) {
      if ((b.holder_type !== "customer" && b.holder_type !== "sales_rep") || !b.holder_id) continue;
      if (holderFilter !== "all" && b.holder_type !== holderFilter) continue;
      const key = `${b.holder_type}:${b.holder_id}`;
      const h = map.get(key) ?? { type: b.holder_type, id: b.holder_id, counts: {} };
      h.counts[b.container_type_id] = Number(b.balance);
      map.set(key, h);
    }
    const term = q.trim().toLowerCase();
    return [...map.values()]
      .map((h) => ({ ...h, name: holderName(h.type, h.id) }))
      .filter((h) => !term || h.name.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances.data, holderFilter, q, customers.data, reps.data]);

  const activeTypes = typeList.filter((t) => t.active);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bottle Tracking</h1>
          <p className="text-sm text-muted-foreground">
            Returnable containers: what's in the warehouse and who is holding the rest. Sales,
            marketer dispatches and returns move them automatically.
          </p>
        </div>
        {canRecord && factoryId && activeTypes.length > 0 && (
          <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <ArrowLeftRight className="h-4 w-4" /> Record movement
              </Button>
            </DialogTrigger>
            {recordOpen && (
              <RecordMovementDialog
                factoryId={factoryId}
                types={activeTypes}
                customers={customers.data ?? []}
                reps={reps.data ?? []}
                canManage={canManage}
                onDone={() => setRecordOpen(false)}
              />
            )}
          </Dialog>
        )}
      </div>

      {typeList.length === 0 && !types.isLoading && (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No container types yet.{" "}
            {canManage
              ? "Add them under Setup below, then link each product to the containers it goes out in."
              : "Ask an admin to set up container types."}
          </CardContent>
        </Card>
      )}

      {typeList.length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Where the containers are</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Container</TableHead>
                  <TableHead className="text-right">In warehouse</TableHead>
                  <TableHead className="text-right">With customers</TableHead>
                  <TableHead className="text-right">With marketers</TableHead>
                  <TableHead className="text-right">Walk-in sales</TableHead>
                  <TableHead className="text-right">Total in circulation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {typeList.map((t) => {
                  const s = summary.get(t.id) ?? {};
                  const w = s.warehouse ?? 0;
                  const c = s.customer ?? 0;
                  const r = s.sales_rep ?? 0;
                  const wi = s.walk_in ?? 0;
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">
                        {t.name}
                        {!t.active && (
                          <Badge variant="outline" className="ml-2 text-muted-foreground">
                            inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{num(w)}</TableCell>
                      <TableCell className="text-right">{num(c)}</TableCell>
                      <TableCell className="text-right">{num(r)}</TableCell>
                      <TableCell className="text-right">{num(wi)}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {num(w + c + r + wi)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {typeList.length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Who is holding containers</CardTitle>
              <p className="text-sm text-muted-foreground">
                A negative number means more came back than was recorded going out — usually
                containers given out before tracking started.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="w-48 pl-8"
                  placeholder="Search name…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <Select
                value={holderFilter}
                onValueChange={(v) => setHolderFilter(v as typeof holderFilter)}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  <SelectItem value="customer">Customers</SelectItem>
                  <SelectItem value="sales_rep">Marketers</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  {typeList.map((t) => (
                    <TableHead key={t.id} className="text-right">
                      {t.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {holders.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={2 + typeList.length}
                      className="py-8 text-center text-muted-foreground"
                    >
                      Nobody is holding containers.
                    </TableCell>
                  </TableRow>
                )}
                {holders.map((h) => (
                  <TableRow key={`${h.type}:${h.id}`}>
                    <TableCell className="font-medium">{h.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {h.type === "customer" ? "Customer" : "Marketer"}
                      </Badge>
                    </TableCell>
                    {typeList.map((t) => {
                      const v = h.counts[t.id] ?? 0;
                      return (
                        <TableCell
                          key={t.id}
                          className={`text-right ${v < 0 ? "text-destructive" : ""}`}
                        >
                          {v === 0 ? "—" : num(v)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {typeList.length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Recent movements</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Container</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Ref / notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(movements.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      {movements.isLoading ? "Loading…" : "No movements yet."}
                    </TableCell>
                  </TableRow>
                )}
                {(movements.data ?? []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(m.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>{SOURCE_LABELS[m.source] ?? m.source}</TableCell>
                    <TableCell>{typeName(m.container_type_id)}</TableCell>
                    <TableCell>{holderName(m.from_type, m.from_id)}</TableCell>
                    <TableCell>{holderName(m.to_type, m.to_id)}</TableCell>
                    <TableCell className="text-right">{num(Number(m.quantity))}</TableCell>
                    <TableCell className="max-w-xs text-xs text-muted-foreground">
                      {[m.reference, m.notes].filter(Boolean).join(" — ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {canManage && factoryId && <SetupCard factoryId={factoryId} types={typeList} />}
    </div>
  );
}

const KINDS = [
  { value: "return", label: "Empties returned", needsHolder: true, admin: false },
  {
    value: "issue",
    label: "Issue containers (opening balance / loan)",
    needsHolder: true,
    admin: false,
  },
  { value: "lost", label: "Lost by holder (write off)", needsHolder: true, admin: true },
  { value: "damaged", label: "Damaged in warehouse (write off)", needsHolder: false, admin: true },
  { value: "purchase", label: "New containers bought in", needsHolder: false, admin: true },
] as const;

function RecordMovementDialog({
  factoryId,
  types,
  customers,
  reps,
  canManage,
  onDone,
}: {
  factoryId: string;
  types: ContainerType[];
  customers: Named[];
  reps: Named[];
  canManage: boolean;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const kinds = KINDS.filter((k) => canManage || !k.admin);
  const [kind, setKind] = useState<string>(kinds[0].value);
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [holderType, setHolderType] = useState<"customer" | "sales_rep" | "walk_in">("customer");
  const [holderId, setHolderId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const spec = KINDS.find((k) => k.value === kind)!;
  const list = holderType === "customer" ? customers : holderType === "sales_rep" ? reps : [];

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("record_container_movement", {
        payload: {
          factory_id: factoryId,
          container_type_id: typeId,
          kind,
          holder_type: spec.needsHolder ? holderType : null,
          holder_id: spec.needsHolder && holderType !== "walk_in" ? holderId : null,
          quantity: Number(quantity),
          notes: notes || null,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Movement recorded");
      qc.invalidateQueries({ queryKey: ["container-balances"] });
      qc.invalidateQueries({ queryKey: ["container-movements"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Record container movement</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>What happened</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Container</Label>
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Quantity</Label>
            <Input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
        </div>
        {spec.needsHolder && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{kind === "issue" ? "Given to" : "From"}</Label>
              <Select
                value={holderType}
                onValueChange={(v) => {
                  setHolderType(v as typeof holderType);
                  setHolderId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">Customer</SelectItem>
                  <SelectItem value="sales_rep">Marketer</SelectItem>
                  {kind !== "issue" && <SelectItem value="walk_in">Walk-in customer</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            {holderType !== "walk_in" && (
              <div>
                <Label>{holderType === "customer" ? "Customer" : "Marketer"}</Label>
                <Select value={holderId} onValueChange={setHolderId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {list.map((x) => (
                      <SelectItem key={x.id} value={x.id}>
                        {x.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}
        <div>
          <Label>
            {kind === "lost" || kind === "damaged" ? "What happened (required)" : "Notes"}
          </Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={
            save.isPending ||
            !typeId ||
            !(Number(quantity) > 0) ||
            (spec.needsHolder && holderType !== "walk_in" && !holderId)
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Record"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function SetupCard({ factoryId, types }: { factoryId: string; types: ContainerType[] }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [productId, setProductId] = useState("");
  const [linkType, setLinkType] = useState("");
  const [perUnit, setPerUnit] = useState("1");

  const products = useQuery({
    queryKey: ["products-brief-active", factoryId],
    queryFn: async () => {
      const { data } = await supabase
        .from("products")
        .select("id,name")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .order("name");
      return (data ?? []) as Named[];
    },
  });
  const links = useQuery({
    queryKey: ["product-containers", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_containers")
        .select("product_id,container_type_id,quantity_per_unit");
      if (error) throw error;
      return data ?? [];
    },
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["container-types"] });
    qc.invalidateQueries({ queryKey: ["product-containers"] });
  };

  const addType = useMutation({
    mutationFn: async (v: { id: string | null; name: string; active: boolean }) => {
      const { error } = await supabase.rpc("save_container_type", {
        p_factory: factoryId,
        p_id: v.id,
        p_name: v.name,
        p_active: v.active,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewName("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const link = useMutation({
    mutationFn: async (v: { product: string; type: string; qty: number }) => {
      const { error } = await supabase.rpc("set_product_container", {
        p_product: v.product,
        p_container_type: v.type,
        p_quantity: v.qty,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Saved");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const productName = (id: string) => products.data?.find((p) => p.id === id)?.name ?? "Product";
  const typeIds = new Set(types.map((t) => t.id));
  const factoryLinks = (links.data ?? []).filter((l) => typeIds.has(l.container_type_id));

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Setup</CardTitle>
        <p className="text-sm text-muted-foreground">
          Container types, and which containers go out with each product. Only linked products move
          containers.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="text-sm font-medium">Container types</div>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. 19L bottle, Crate, Dispenser"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button
              className="gap-1"
              disabled={!newName.trim() || addType.isPending}
              onClick={() => addType.mutate({ id: null, name: newName, active: true })}
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          {types.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span className={t.active ? "" : "text-muted-foreground line-through"}>{t.name}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => addType.mutate({ id: t.id, name: t.name, active: !t.active })}
              >
                {t.active ? "Deactivate" : "Activate"}
              </Button>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="text-sm font-medium">Product → containers</div>
          <div className="grid grid-cols-[1fr_1fr_5rem_auto] gap-2">
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger>
                <SelectValue placeholder="Product" />
              </SelectTrigger>
              <SelectContent>
                {(products.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={linkType} onValueChange={setLinkType}>
              <SelectTrigger>
                <SelectValue placeholder="Container" />
              </SelectTrigger>
              <SelectContent>
                {types
                  .filter((t) => t.active)
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              step="1"
              title="Containers per unit"
              value={perUnit}
              onChange={(e) => setPerUnit(e.target.value)}
            />
            <Button
              disabled={!productId || !linkType || !(Number(perUnit) > 0) || link.isPending}
              onClick={() =>
                link.mutate({ product: productId, type: linkType, qty: Number(perUnit) })
              }
            >
              Link
            </Button>
          </div>
          {factoryLinks.length === 0 && (
            <p className="text-sm text-muted-foreground">No products linked yet.</p>
          )}
          {factoryLinks.map((l) => (
            <div
              key={`${l.product_id}:${l.container_type_id}`}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span>
                {productName(l.product_id)} → {num(Number(l.quantity_per_unit))} ×{" "}
                {types.find((t) => t.id === l.container_type_id)?.name}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  link.mutate({ product: l.product_id, type: l.container_type_id, qty: 0 })
                }
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
