import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, Plus, Trash2 } from "lucide-react";
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
import { RefId } from "@/components/shared/ref-id";
import { SearchBox } from "@/components/shared/search-box";
import {
  db,
  ISSUE_STATUS_LABELS,
  LOG_TYPE_LABELS,
  MAINTENANCE_QUERY_KEYS,
  movementValue,
  pendingOutByPart,
  useMaintenanceIssues,
  useMaintenanceLogs,
  useMaintenanceMovements,
  useMaintenanceParts,
  type LogRow,
} from "./shared";

type VehicleOption = {
  id: string;
  plate_number: string;
  brand: string | null;
  model: string | null;
};
type RequestOption = { id: string; request_number: string; title: string; status: string };

const VEHICLE_TYPES = new Set(["vehicle_repair", "vehicle_service"]);

const emptyLogForm = () => ({
  log_type: "",
  title: "",
  description: "",
  vehicle_id: "",
  asset_name: "",
  service_date: new Date().toISOString().slice(0, 10),
  performed_by: "",
  odometer: "",
  labour_cost: "",
  other_cost: "",
  next_service_date: "",
  request_id: "",
});

export function MaintenanceLogTab({
  factoryId,
  write,
  vehicles,
  requests,
}: {
  factoryId: string | null | undefined;
  write: boolean;
  vehicles: VehicleOption[];
  requests: RequestOption[];
}) {
  const qc = useQueryClient();
  const [q, setQ] = useSearchQuery();
  const [typeFilter, setTypeFilter] = useState("all");
  const [logOpen, setLogOpen] = useState(false);
  const [form, setForm] = useState(emptyLogForm);
  const [lines, setLines] = useState<{ part_id: string; quantity: string }[]>([]);
  const [viewing, setViewing] = useState<LogRow | null>(null);

  const logs = useMaintenanceLogs(factoryId);
  const parts = useMaintenanceParts(factoryId);
  const movements = useMaintenanceMovements(factoryId);
  const issues = useMaintenanceIssues(factoryId);
  const pendingOut = pendingOutByPart(issues.data);
  // What can still be requested: on hand less what's already awaiting approval.
  const available = (partId: string) =>
    Number(partsById.get(partId)?.quantity_on_hand ?? 0) - (pendingOut.get(partId) ?? 0);

  const partsCostByLog = new Map<string, number>();
  for (const m of movements.data ?? []) {
    if (m.log_id)
      partsCostByLog.set(m.log_id, (partsCostByLog.get(m.log_id) ?? 0) + movementValue(m));
  }
  const totalCost = (l: LogRow) =>
    Number(l.labour_cost) + Number(l.other_cost) + (partsCostByLog.get(l.id) ?? 0);

  const rows = (logs.data ?? [])
    .filter((l) => typeFilter === "all" || l.log_type === typeFilter)
    .filter((l) => matchesSearch(q, l));
  const openRequests = requests.filter((r) => r.status === "approved" || r.status === "completed");
  const partsById = new Map((parts.data ?? []).map((p) => [p.id, p]));
  const isVehicle = VEHICLE_TYPES.has(form.log_type);

  const resetForm = () => {
    setForm(emptyLogForm());
    setLines([]);
  };

  const createLog = useMutation({
    mutationFn: async () => {
      const { data, error } = await db.rpc("create_maintenance_log", {
        payload: {
          factory_id: factoryId,
          log_type: form.log_type,
          title: form.title,
          description: form.description || null,
          vehicle_id: isVehicle ? form.vehicle_id || null : null,
          asset_name: isVehicle ? null : form.asset_name || null,
          service_date: form.service_date,
          performed_by: form.performed_by || null,
          odometer: isVehicle && form.odometer !== "" ? Number(form.odometer) : null,
          labour_cost: form.labour_cost === "" ? 0 : Number(form.labour_cost),
          other_cost: form.other_cost === "" ? 0 : Number(form.other_cost),
          next_service_date: form.next_service_date || null,
          request_id: form.request_id || null,
          parts: lines
            .filter((l) => l.part_id && Number(l.quantity) > 0)
            .map((l) => ({ part_id: l.part_id, quantity: Number(l.quantity) })),
        },
      });
      if (error) throw error;
      return data as { id: string; log_number: string; parts_pending_approval?: number };
    },
    onSuccess: (res) => {
      toast.success(
        res.parts_pending_approval
          ? `Maintenance ${res.log_number} logged — parts sent for approval`
          : `Maintenance ${res.log_number} logged`,
      );
      logAudit({ action: "create", entity: "maintenance_logs", entityId: res.id, factoryId });
      MAINTENANCE_QUERY_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey }));
      setLogOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const linesValid = lines.every((l) => {
    if (!l.part_id && !l.quantity) return true;
    return (
      partsById.has(l.part_id) &&
      Number(l.quantity) > 0 &&
      Number(l.quantity) <= available(l.part_id)
    );
  });
  const viewingParts = (movements.data ?? []).filter((m) => m.log_id === viewing?.id);
  // Approved issues already show as movements above; list the rest with their status.
  const viewingUnissued = (issues.data ?? []).filter(
    (i) => i.log_id === viewing?.id && i.status !== "approved",
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All work types</SelectItem>
            {Object.entries(LOG_TYPE_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {write && (
          <Button onClick={() => setLogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Log Maintenance
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
                <TableHead>Log #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Work done</TableHead>
                <TableHead>Vehicle / machine</TableHead>
                <TableHead>Done by</TableHead>
                <TableHead className="text-right">Parts</TableHead>
                <TableHead className="text-right">Total cost</TableHead>
                <TableHead>Next service</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <RefId id={l.id} />
                  </TableCell>
                  <TableCell className="font-medium whitespace-nowrap">{l.log_number}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {new Date(l.service_date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {LOG_TYPE_LABELS[l.log_type] ?? l.log_type}
                  </TableCell>
                  <TableCell>{l.title}</TableCell>
                  <TableCell>{l.vehicles?.plate_number ?? l.asset_name ?? "—"}</TableCell>
                  <TableCell>{l.performed_by ?? "—"}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {partsCostByLog.has(l.id) ? money(partsCostByLog.get(l.id)) : "—"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {money(totalCost(l))}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {l.next_service_date ? (
                      <Badge
                        variant={
                          l.next_service_date <= new Date().toISOString().slice(0, 10)
                            ? "destructive"
                            : "outline"
                        }
                      >
                        {new Date(l.next_service_date).toLocaleDateString()}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" title="Open" onClick={() => setViewing(l)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    {logs.isError ? "Couldn't load the maintenance log." : "No maintenance logged."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ---------- new log entry ---------- */}
      <Dialog
        open={logOpen}
        onOpenChange={(v) => {
          setLogOpen(v);
          if (!v) resetForm();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Log Maintenance</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Type of work</Label>
                <Select
                  value={form.log_type}
                  onValueChange={(v) => setForm({ ...form, log_type: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(LOG_TYPE_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date done</Label>
                <Input
                  type="date"
                  value={form.service_date}
                  onChange={(e) => setForm({ ...form, service_date: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Work done</Label>
              <Input
                placeholder="e.g. Replaced brake pads, rewound pump motor"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            {isVehicle ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Vehicle</Label>
                  <Select
                    value={form.vehicle_id}
                    onValueChange={(v) => setForm({ ...form, vehicle_id: v })}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          vehicles.length === 0
                            ? "No vehicles — add one in Vehicles"
                            : "Select vehicle"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {vehicles.map((v) => (
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
                <div className="space-y-2">
                  <Label>Odometer (optional)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={form.odometer}
                    onChange={(e) => setForm({ ...form, odometer: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Machine / part / area</Label>
                <Input
                  placeholder="e.g. Sachet machine 2, borehole pump, generator"
                  value={form.asset_name}
                  onChange={(e) => setForm({ ...form, asset_name: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Details (optional)</Label>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Done by</Label>
                <Input
                  placeholder="Mechanic / technician"
                  value={form.performed_by}
                  onChange={(e) => setForm({ ...form, performed_by: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Labour cost</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.labour_cost}
                  onChange={(e) => setForm({ ...form, labour_cost: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Other costs</Label>
                <Input
                  type="number"
                  min="0"
                  placeholder="Transport, outside parts"
                  value={form.other_cost}
                  onChange={(e) => setForm({ ...form, other_cost: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <Label>Parts used from stock</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setLines([...lines, { part_id: "", quantity: "" }])}
                >
                  <Plus className="mr-1 h-3 w-3" /> Add part
                </Button>
              </div>
              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Parts added here are sent for approval, then taken out of the parts inventory.
                </p>
              )}
              {lines.map((line, i) => {
                const p = partsById.get(line.part_id);
                const over = !!p && Number(line.quantity) > available(p.id);
                return (
                  <div key={i} className="flex items-start gap-2">
                    <Select
                      value={line.part_id}
                      onValueChange={(v) =>
                        setLines(lines.map((l, j) => (j === i ? { ...l, part_id: v } : l)))
                      }
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select part" />
                      </SelectTrigger>
                      <SelectContent>
                        {(parts.data ?? [])
                          .filter((x) => x.is_active && available(x.id) > 0)
                          .map((x) => (
                            <SelectItem key={x.id} value={x.id}>
                              {x.name} — {num(available(x.id))} {x.unit} available
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <div className="w-28">
                      <Input
                        type="number"
                        min="0"
                        placeholder="Qty"
                        value={line.quantity}
                        className={over ? "border-destructive" : undefined}
                        onChange={(e) =>
                          setLines(
                            lines.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)),
                          )
                        }
                      />
                      {over && (
                        <p className="text-xs text-destructive">Only {num(available(p!.id))}</p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Remove"
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Next service due (optional)</Label>
                <Input
                  type="date"
                  value={form.next_service_date}
                  onChange={(e) => setForm({ ...form, next_service_date: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>For approved request (optional)</Label>
                <Select
                  value={form.request_id || "none"}
                  onValueChange={(v) => setForm({ ...form, request_id: v === "none" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {openRequests.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.request_number} — {r.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!form.log_type || !form.title.trim() || !linesValid || createLog.isPending}
              onClick={() => createLog.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- log detail ---------- */}
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {viewing.log_number} — {LOG_TYPE_LABELS[viewing.log_type] ?? viewing.log_type}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-base font-medium">{viewing.title}</div>
                  <div className="text-muted-foreground">
                    {new Date(viewing.service_date).toLocaleDateString()}
                    {(viewing.vehicles?.plate_number ?? viewing.asset_name) &&
                      ` · ${viewing.vehicles?.plate_number ?? viewing.asset_name}`}
                    {viewing.odometer != null && ` · ${num(Number(viewing.odometer))} km`}
                  </div>
                  {viewing.description && (
                    <p className="mt-2 whitespace-pre-wrap">{viewing.description}</p>
                  )}
                </div>
                <div className="grid gap-1 sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">Done by: </span>
                    {viewing.performed_by ?? "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Logged by: </span>
                    {viewing.recorded_by_name ?? "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Labour: </span>
                    {money(Number(viewing.labour_cost))}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Other costs: </span>
                    {money(Number(viewing.other_cost))}
                  </div>
                  {viewing.maintenance_requests && (
                    <div>
                      <span className="text-muted-foreground">Request: </span>
                      {viewing.maintenance_requests.request_number}
                    </div>
                  )}
                  {viewing.next_service_date && (
                    <div>
                      <span className="text-muted-foreground">Next service: </span>
                      {new Date(viewing.next_service_date).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Part used</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {viewingParts.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>{m.maintenance_parts?.name ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            {num(Math.abs(Number(m.quantity)))} {m.maintenance_parts?.unit}
                          </TableCell>
                          <TableCell className="text-right">
                            {m.unit_cost != null ? money(movementValue(m)) : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">Issued</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                      {viewingUnissued.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell>{i.maintenance_parts?.name ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            {num(Number(i.quantity))} {i.maintenance_parts?.unit}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell>
                            <Badge
                              variant={i.status === "pending_approval" ? "outline" : "destructive"}
                            >
                              {ISSUE_STATUS_LABELS[i.status] ?? i.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                      {viewingParts.length === 0 && viewingUnissued.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                            No parts taken from stock.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div className="text-right font-medium">Total: {money(totalCost(viewing))}</div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
