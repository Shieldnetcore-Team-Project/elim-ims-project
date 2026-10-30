import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  History,
  Pencil,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { logAudit } from "@/lib/audit";
import { money, num } from "@/lib/format";
import { matchesSearch, useSearchQuery } from "@/lib/search";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { SearchBox } from "@/components/shared/search-box";
import {
  db,
  isLowStock,
  MAINTENANCE_QUERY_KEYS,
  MOVEMENT_LABELS,
  movementValue,
  PART_CATEGORY_LABELS,
  useMaintenanceMovements,
  useMaintenanceParts,
  useMaintenanceIssues,
  pendingOutByPart,
  type MovementRow,
  type PartRow,
} from "./shared";

type StockType = "received" | "purchased" | "issued" | "returned" | "adjustment";

const emptyPartForm = {
  name: "",
  part_number: "",
  category: "machine_part",
  unit: "pcs",
  location: "",
  reorder_level: "",
  opening_quantity: "",
  unit_cost: "",
  notes: "",
};

const emptyStockForm = () => ({
  part_id: "",
  movement_type: "purchased" as StockType,
  quantity: "",
  unit_cost: "",
  movement_date: new Date().toISOString().slice(0, 10),
  source: "",
  reference: "",
  notes: "",
});

const signedQty = (m: MovementRow) => {
  const n = Number(m.quantity);
  return `${n > 0 ? "+" : ""}${num(n)} ${m.maintenance_parts?.unit ?? ""}`.trim();
};

export function PartsInventoryTab({
  factoryId,
  write,
  canAdjust,
}: {
  factoryId: string | null | undefined;
  write: boolean;
  canAdjust: boolean;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useSearchQuery();
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [lowOnly, setLowOnly] = useState(false);
  const [partOpen, setPartOpen] = useState(false);
  const [editingPart, setEditingPart] = useState<PartRow | null>(null);
  const [partForm, setPartForm] = useState(emptyPartForm);
  const [stockOpen, setStockOpen] = useState(false);
  const [stockForm, setStockForm] = useState(emptyStockForm);
  const [historyPart, setHistoryPart] = useState<PartRow | null>(null);

  const parts = useMaintenanceParts(factoryId);
  const movements = useMaintenanceMovements(factoryId);
  const issues = useMaintenanceIssues(factoryId);
  const pendingOut = pendingOutByPart(issues.data);

  const invalidate = () =>
    MAINTENANCE_QUERY_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey }));

  const visibleParts = (parts.data ?? [])
    .filter((p) => categoryFilter === "all" || p.category === categoryFilter)
    .filter((p) => !lowOnly || isLowStock(p))
    .filter((p) => matchesSearch(q, p));
  const stockPart = (parts.data ?? []).find((p) => p.id === stockForm.part_id) ?? null;
  const historyRows = (movements.data ?? []).filter((m) => m.part_id === historyPart?.id);

  const savePart = useMutation({
    mutationFn: async () => {
      const { data, error } = await db.rpc("save_maintenance_part", {
        payload: {
          id: editingPart?.id ?? null,
          factory_id: factoryId,
          name: partForm.name,
          part_number: partForm.part_number || null,
          category: partForm.category,
          unit: partForm.unit,
          location: partForm.location || null,
          reorder_level: partForm.reorder_level === "" ? null : Number(partForm.reorder_level),
          opening_quantity:
            partForm.opening_quantity === "" ? null : Number(partForm.opening_quantity),
          unit_cost: partForm.unit_cost === "" ? null : Number(partForm.unit_cost),
          notes: partForm.notes || null,
        },
      });
      if (error) throw error;
      return data as { id: string };
    },
    onSuccess: (res) => {
      toast.success(editingPart ? "Part updated" : "Part added");
      logAudit({
        action: editingPart ? "update" : "create",
        entity: "maintenance_parts",
        entityId: res.id,
        factoryId,
      });
      invalidate();
      setPartOpen(false);
      setEditingPart(null);
      setPartForm(emptyPartForm);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recordStock = useMutation({
    mutationFn: async () => {
      const { data, error } = await db.rpc("record_maintenance_stock", {
        payload: {
          part_id: stockForm.part_id,
          movement_type: stockForm.movement_type,
          quantity: Number(stockForm.quantity),
          unit_cost: stockForm.unit_cost === "" ? null : Number(stockForm.unit_cost),
          movement_date: stockForm.movement_date,
          source: stockForm.source || null,
          reference: stockForm.reference || null,
          notes: stockForm.notes || null,
        },
      });
      if (error) throw error;
      return data as { id: string; pending_approval: boolean };
    },
    onSuccess: (res) => {
      toast.success(
        res.pending_approval
          ? "Sent for approval — stock goes down once it's approved"
          : "Stock updated",
      );
      logAudit({
        action: "create",
        entity: res.pending_approval ? "maintenance_issue_requests" : "maintenance_stock_movements",
        entityId: stockForm.part_id,
        factoryId,
        newValue: { type: stockForm.movement_type, quantity: stockForm.quantity },
      });
      invalidate();
      setStockOpen(false);
      setStockForm(emptyStockForm());
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openStock = (part: PartRow | null, type: StockType) => {
    setStockForm({
      ...emptyStockForm(),
      part_id: part?.id ?? "",
      movement_type: type,
      unit_cost:
        type === "purchased" && part?.last_unit_cost != null ? String(part.last_unit_cost) : "",
    });
    setStockOpen(true);
  };

  const stockQty = Number(stockForm.quantity);
  const takesOut =
    stockForm.movement_type === "issued" ||
    (stockForm.movement_type === "adjustment" && stockQty < 0);
  const stockAvailable = stockPart
    ? Number(stockPart.quantity_on_hand) - (pendingOut.get(stockPart.id) ?? 0)
    : 0;
  const overAvailable = takesOut && !!stockPart && Math.abs(stockQty) > stockAvailable;
  const stockValid =
    !!stockForm.part_id &&
    !!stockForm.quantity &&
    stockQty !== 0 &&
    !overAvailable &&
    (stockForm.movement_type === "adjustment" || stockQty > 0) &&
    (stockForm.movement_type !== "purchased" || stockForm.unit_cost !== "") &&
    (stockForm.movement_type !== "adjustment" || !!stockForm.notes.trim());
  const stockLabels: Record<StockType, string> = {
    purchased: "Record parts bought",
    received: "Record parts received",
    issued: "Request to issue parts",
    returned: "Return parts to store",
    adjustment: "Adjust stock count",
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {Object.entries(PART_CATEGORY_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={lowOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setLowOnly(!lowOnly)}
          >
            Low stock only
          </Button>
        </div>
        {write && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => openStock(null, "purchased")}>
              <ArrowDownToLine className="mr-2 h-4 w-4" /> Receive / Buy
            </Button>
            <Button variant="outline" onClick={() => openStock(null, "issued")}>
              <ArrowUpFromLine className="mr-2 h-4 w-4" /> Issue
            </Button>
            <Button
              onClick={() => {
                setEditingPart(null);
                setPartForm(emptyPartForm);
                setPartOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> Add Part
            </Button>
          </div>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto pt-6">
          <SearchBox value={q} onChange={setQ} className="mb-3" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Part / item</TableHead>
                <TableHead>Part #</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reorder at</TableHead>
                <TableHead className="text-right">Last cost</TableHead>
                <TableHead className="text-right">Stock value</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleParts.map((p) => (
                <TableRow key={p.id} className={p.is_active ? undefined : "opacity-60"}>
                  <TableCell className="font-medium">
                    {p.name}
                    {!p.is_active && (
                      <Badge variant="outline" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{p.part_number ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {PART_CATEGORY_LABELS[p.category] ?? p.category}
                  </TableCell>
                  <TableCell>{p.location ?? "—"}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {isLowStock(p) ? (
                      <Badge variant="destructive">
                        {num(Number(p.quantity_on_hand))} {p.unit}
                      </Badge>
                    ) : (
                      `${num(Number(p.quantity_on_hand))} ${p.unit}`
                    )}
                    {pendingOut.has(p.id) && (
                      <div className="text-xs text-muted-foreground">
                        {num(pendingOut.get(p.id))} awaiting approval
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {Number(p.reorder_level) > 0 ? num(Number(p.reorder_level)) : "—"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {p.last_unit_cost != null ? money(Number(p.last_unit_cost)) : "—"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {money(Number(p.quantity_on_hand) * Number(p.last_unit_cost ?? 0))}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {write && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Receive / buy"
                            onClick={() => openStock(p, "purchased")}
                          >
                            <ArrowDownToLine className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Issue / use"
                            disabled={Number(p.quantity_on_hand) - (pendingOut.get(p.id) ?? 0) <= 0}
                            onClick={() => openStock(p, "issued")}
                          >
                            <ArrowUpFromLine className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {canAdjust && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Adjust count"
                          onClick={() => openStock(p, "adjustment")}
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Stock history"
                        onClick={() => setHistoryPart(p)}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      {canAdjust && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit"
                          onClick={() => {
                            setEditingPart(p);
                            setPartForm({
                              name: p.name,
                              part_number: p.part_number ?? "",
                              category: p.category,
                              unit: p.unit,
                              location: p.location ?? "",
                              reorder_level: String(Number(p.reorder_level)),
                              opening_quantity: "",
                              unit_cost: "",
                              notes: p.notes ?? "",
                            });
                            setPartOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {visibleParts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {parts.isError ? "Couldn't load parts." : "No parts on file."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ---------- add / edit part ---------- */}
      <Dialog
        open={partOpen}
        onOpenChange={(v) => {
          setPartOpen(v);
          if (!v) {
            setEditingPart(null);
            setPartForm(emptyPartForm);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingPart ? "Edit Part" : "Add Part"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                placeholder="e.g. Heater band 220V, Engine oil 20W-50"
                value={partForm.name}
                onChange={(e) => setPartForm({ ...partForm, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Part number (optional)</Label>
                <Input
                  value={partForm.part_number}
                  onChange={(e) => setPartForm({ ...partForm, part_number: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={partForm.category}
                  onValueChange={(v) => setPartForm({ ...partForm, category: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PART_CATEGORY_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Unit</Label>
                <Input
                  placeholder="pcs, litres, kg"
                  value={partForm.unit}
                  onChange={(e) => setPartForm({ ...partForm, unit: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Reorder at</Label>
                <Input
                  type="number"
                  min="0"
                  value={partForm.reorder_level}
                  onChange={(e) => setPartForm({ ...partForm, reorder_level: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Location</Label>
                <Input
                  placeholder="Store, shelf"
                  value={partForm.location}
                  onChange={(e) => setPartForm({ ...partForm, location: e.target.value })}
                />
              </div>
            </div>
            {!editingPart && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Quantity in stock now</Label>
                  <Input
                    type="number"
                    min="0"
                    value={partForm.opening_quantity}
                    onChange={(e) => setPartForm({ ...partForm, opening_quantity: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Unit cost (optional)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={partForm.unit_cost}
                    onChange={(e) => setPartForm({ ...partForm, unit_cost: e.target.value })}
                  />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                rows={2}
                placeholder="Which machine or vehicle it fits, specs"
                value={partForm.notes}
                onChange={(e) => setPartForm({ ...partForm, notes: e.target.value })}
              />
            </div>
            {editingPart && (
              <p className="text-xs text-muted-foreground">
                Stock on hand changes only through Receive / Buy, Issue or Adjust.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={!partForm.name.trim() || !partForm.unit.trim() || savePart.isPending}
              onClick={() => savePart.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- stock in / out ---------- */}
      <Dialog
        open={stockOpen}
        onOpenChange={(v) => {
          setStockOpen(v);
          if (!v) setStockForm(emptyStockForm());
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{stockLabels[stockForm.movement_type]}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={stockForm.movement_type}
                  onValueChange={(v) =>
                    setStockForm({ ...stockForm, movement_type: v as StockType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="purchased">Bought</SelectItem>
                    <SelectItem value="received">Received (not bought)</SelectItem>
                    <SelectItem value="issued">Issued / used</SelectItem>
                    <SelectItem value="returned">Returned to store</SelectItem>
                    {canAdjust && <SelectItem value="adjustment">Adjustment</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={stockForm.movement_date}
                  onChange={(e) => setStockForm({ ...stockForm, movement_date: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Part</Label>
              <Select
                value={stockForm.part_id}
                onValueChange={(v) => setStockForm({ ...stockForm, part_id: v })}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      (parts.data?.length ?? 0) === 0 ? "No parts — add one first" : "Select part"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(parts.data ?? [])
                    .filter((p) => p.is_active)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.part_number ? ` (${p.part_number})` : ""} —{" "}
                        {num(Number(p.quantity_on_hand))} {p.unit} on hand
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>
                  {stockForm.movement_type === "adjustment"
                    ? "Change (+ found / − missing)"
                    : `Quantity${stockPart ? ` (${stockPart.unit})` : ""}`}
                </Label>
                <Input
                  type="number"
                  value={stockForm.quantity}
                  onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })}
                />
              </div>
              {(stockForm.movement_type === "purchased" ||
                stockForm.movement_type === "received") && (
                <div className="space-y-2">
                  <Label>
                    Unit cost{stockForm.movement_type === "received" ? " (optional)" : ""}
                  </Label>
                  <Input
                    type="number"
                    min="0"
                    value={stockForm.unit_cost}
                    onChange={(e) => setStockForm({ ...stockForm, unit_cost: e.target.value })}
                  />
                </div>
              )}
            </div>
            {stockForm.movement_type === "purchased" && stockForm.unit_cost !== "" && (
              <p className="text-sm">
                Total:{" "}
                <span className="font-medium">
                  {money((stockQty || 0) * Number(stockForm.unit_cost))}
                </span>
              </p>
            )}
            {stockForm.movement_type !== "adjustment" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>
                    {stockForm.movement_type === "issued"
                      ? "Issued to / used on"
                      : stockForm.movement_type === "returned"
                        ? "Returned by"
                        : stockForm.movement_type === "purchased"
                          ? "Supplier / shop"
                          : "Received from"}
                  </Label>
                  <Input
                    value={stockForm.source}
                    onChange={(e) => setStockForm({ ...stockForm, source: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Receipt / reference</Label>
                  <Input
                    value={stockForm.reference}
                    onChange={(e) => setStockForm({ ...stockForm, reference: e.target.value })}
                  />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label>
                {stockForm.movement_type === "adjustment" ? "Reason" : "Notes (optional)"}
              </Label>
              <Textarea
                rows={2}
                value={stockForm.notes}
                onChange={(e) => setStockForm({ ...stockForm, notes: e.target.value })}
              />
            </div>
            {overAvailable && (
              <p className="text-xs text-destructive">
                Only {num(stockAvailable)} {stockPart?.unit} available
                {pendingOut.has(stockPart!.id) ? " after requests already awaiting approval" : ""}.
              </p>
            )}
            {takesOut && (
              <p className="text-xs text-muted-foreground">
                This goes for approval. Stock goes down only once it's approved
                {stockForm.movement_type === "issued"
                  ? " — parts used on a repair can also be requested from the Maintenance Log entry."
                  : "."}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={!stockValid || recordStock.isPending}
              onClick={() => recordStock.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- part history ---------- */}
      <Dialog open={!!historyPart} onOpenChange={(v) => !v && setHistoryPart(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {historyPart?.name} — {num(Number(historyPart?.quantity_on_hand ?? 0))}{" "}
              {historyPart?.unit} on hand
            </DialogTitle>
          </DialogHeader>
          <MovementsTable rows={historyRows} showPart={false} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StockMovementsTab({ factoryId }: { factoryId: string | null | undefined }) {
  const [q, setQ] = useSearchQuery();
  const [typeFilter, setTypeFilter] = useState("all");
  const movements = useMaintenanceMovements(factoryId);
  const rows = (movements.data ?? [])
    .filter((m) => typeFilter === "all" || m.movement_type === typeFilter)
    .filter((m) => matchesSearch(q, { ...m, part: m.maintenance_parts?.name }));

  return (
    <div className="space-y-4">
      <Select value={typeFilter} onValueChange={setTypeFilter}>
        <SelectTrigger className="w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All movements</SelectItem>
          {Object.entries(MOVEMENT_LABELS).map(([k, label]) => (
            <SelectItem key={k} value={k}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto pt-6">
          <SearchBox value={q} onChange={setQ} className="mb-3" />
          <MovementsTable rows={rows} showPart error={movements.isError} />
        </CardContent>
      </Card>
    </div>
  );
}

function MovementsTable({
  rows,
  showPart,
  error,
}: {
  rows: MovementRow[];
  showPart: boolean;
  error?: boolean;
}) {
  const cols = showPart ? 10 : 9;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          {showPart && <TableHead>Part</TableHead>}
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Balance</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>From / to</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead>By</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => (
          <TableRow key={m.id}>
            <TableCell className="whitespace-nowrap">
              {new Date(m.movement_date).toLocaleDateString()}
            </TableCell>
            {showPart && (
              <TableCell className="font-medium">{m.maintenance_parts?.name ?? "—"}</TableCell>
            )}
            <TableCell>
              <Badge
                variant={Number(m.quantity) < 0 ? "outline" : "secondary"}
                className="whitespace-nowrap"
              >
                {MOVEMENT_LABELS[m.movement_type] ?? m.movement_type}
              </Badge>
            </TableCell>
            <TableCell
              className={`text-right whitespace-nowrap ${Number(m.quantity) < 0 ? "text-destructive" : ""}`}
            >
              {signedQty(m)}
            </TableCell>
            <TableCell className="text-right">{num(Number(m.balance_after))}</TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {m.unit_cost != null ? money(movementValue(m)) : "—"}
            </TableCell>
            <TableCell>{m.source ?? "—"}</TableCell>
            <TableCell>{m.reference ?? "—"}</TableCell>
            <TableCell className="max-w-56 text-xs">{m.notes ?? "—"}</TableCell>
            <TableCell className="text-xs whitespace-nowrap">{m.recorded_by_name ?? "—"}</TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={cols} className="text-center text-muted-foreground py-8">
              {error ? "Couldn't load stock movements." : "No stock movements."}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
