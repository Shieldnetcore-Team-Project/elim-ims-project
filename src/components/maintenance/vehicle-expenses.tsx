import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Fuel, Pencil, Plus, Printer, Trash2, X } from "lucide-react";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { localDay } from "@/lib/production-shift";
import { useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { generateVehicleExpensesPdf, type VehicleExpenseSheet } from "@/lib/pdf";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
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
import { MAINTENANCE_EXPENSE_CATEGORIES } from "./expenses";
import { db } from "./shared";

// Maintenance › Vehicle Expenses: the factory's "DAILY VEHICLE EXPENSES FOR
// <PLATE> <DRIVERS>" sheet, per vehicle (user, 2026-11-21). Particulars
// (parts, oil, servicing) then fuel (litres at a price), each with a total,
// and a grand total. Saved in maintenance_expenses, so the lines also show
// on the Expenses tab under their heads (fuel = FUEL).

type Vehicle = { id: string; plate_number: string; make_model?: string | null };

type Line = {
  id: string;
  expense_number: string;
  expense_date: string;
  category: string;
  description: string | null;
  amount: number;
  payment_method: string | null;
  vehicle_id: string;
  driver_name: string | null;
  line_kind: "part" | "fuel" | null;
  quantity: number | null;
  unit_price: number | null;
  approval_status: "pending_review" | "approved" | "rejected";
};

type DraftLine = {
  key: number;
  category: string;
  description: string;
  quantity: string;
  unit_price: number;
  amount: number;
  amountTouched: boolean;
};

const PAYMENT_METHODS = ["Cash", "Transfer", "POS", "Cheque"];
const monthStart = () => localDay().slice(0, 8) + "01";
const fmtDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString();
const n0 = (v: unknown) => Number(v ?? 0) || 0;
const plain = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

let nextKey = 1;
const blankLine = (category: string): DraftLine => ({
  key: nextKey++,
  category,
  description: "",
  quantity: "",
  unit_price: 0,
  amount: 0,
  amountTouched: false,
});

// "8 LITERS OF ENGINE OIL AT #3,400" -- the sheet's wording.
function lineText(l: Pick<Line, "line_kind" | "description" | "quantity" | "unit_price">) {
  const q = n0(l.quantity);
  const p = n0(l.unit_price);
  if (l.line_kind === "fuel") {
    const base = `${plain(q)} liters of fuel${p ? ` at #${plain(p)}` : ""}`;
    return l.description ? `${base} (${l.description})` : base;
  }
  const d = l.description ?? "";
  if (q && p) return `${d} — ${plain(q)} at #${plain(p)}`;
  if (q) return `${d} (${plain(q)})`;
  return d;
}

const isFuel = (l: Line) => l.line_kind === "fuel";

export function VehicleExpensesTab({
  factoryId,
  vehicles,
  canCreate,
  canEdit,
  canDelete,
}: {
  factoryId: string | null | undefined;
  vehicles: Vehicle[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const qc = useQueryClient();
  const settings = useFactorySettings(factoryId ?? undefined);
  const me = useCurrentUserName();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(localDay);
  const [vehicleFilter, setVehicleFilter] = useState("all");

  // New sheet.
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState({
    vehicle_id: "",
    expense_date: localDay(),
    driver_name: "",
    payment_method: "Cash",
  });
  const [parts, setParts] = useState<DraftLine[]>([blankLine("VEHICLE MAINT.")]);
  const [fuel, setFuel] = useState<DraftLine[]>([blankLine("FUEL")]);

  // One line's correction.
  const [editing, setEditing] = useState<Line | null>(null);
  const [edit, setEdit] = useState({
    expense_date: "",
    category: "",
    description: "",
    quantity: "",
    unit_price: 0,
    amount: 0,
    driver_name: "",
  });
  const [deleting, setDeleting] = useState<Line | null>(null);

  const lines = useQuery({
    queryKey: ["maintenance-vehicle-expenses", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      let query = db
        .from("maintenance_expenses")
        .select(
          "id,expense_number,expense_date,category,description,amount,payment_method,vehicle_id,driver_name,line_kind,quantity,unit_price,approval_status,created_at",
        )
        .eq("factory_id", factoryId)
        .not("vehicle_id", "is", null)
        .order("expense_date", { ascending: true })
        .order("created_at", { ascending: true });
      if (from) query = query.gte("expense_date", from);
      if (to) query = query.lte("expense_date", to);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Line[];
    },
  });

  const vehicleById = useMemo(() => new Map(vehicles.map((v) => [v.id, v])), [vehicles]);

  // One block per vehicle, in plate order.
  const groups = useMemo(() => {
    const by = new Map<string, Line[]>();
    for (const l of lines.data ?? []) {
      if (vehicleFilter !== "all" && l.vehicle_id !== vehicleFilter) continue;
      const arr = by.get(l.vehicle_id) ?? [];
      arr.push(l);
      by.set(l.vehicle_id, arr);
    }
    return [...by.entries()]
      .map(([id, ls]) => {
        const v = vehicleById.get(id);
        const partLines = ls.filter((l) => !isFuel(l));
        const fuelLines = ls.filter(isFuel);
        const drivers = [
          ...new Set(ls.map((l) => (l.driver_name ?? "").trim()).filter(Boolean)),
        ].join(", ");
        return {
          id,
          plate: v?.plate_number ?? "Unknown vehicle",
          model: v?.make_model ?? null,
          drivers,
          parts: partLines,
          fuel: fuelLines,
          partsTotal: partLines.reduce((s, l) => s + n0(l.amount), 0),
          fuelTotal: fuelLines.reduce((s, l) => s + n0(l.amount), 0),
          litres: fuelLines.reduce((s, l) => s + n0(l.quantity), 0),
        };
      })
      .sort((a, b) => a.plate.localeCompare(b.plate));
  }, [lines.data, vehicleFilter, vehicleById]);

  const grandTotal = groups.reduce((s, g) => s + g.partsTotal + g.fuelTotal, 0);
  const totalLitres = groups.reduce((s, g) => s + g.litres, 0);
  const period = `${from ? fmtDate(from) : "start"} to ${to ? fmtDate(to) : "today"}`;

  const print = (gs: typeof groups) => {
    const sheets: VehicleExpenseSheet[] = gs.map((g) => ({
      plate: g.plate,
      model: g.model,
      drivers: g.drivers ? g.drivers.replace(/, /g, "/") : null,
      parts: g.parts.map((l) => ({
        date: fmtDate(l.expense_date),
        text: lineText(l),
        amount: n0(l.amount),
      })),
      fuel: g.fuel.map((l) => ({
        date: fmtDate(l.expense_date),
        text: lineText(l),
        litres: n0(l.quantity),
        amount: n0(l.amount),
      })),
    }));
    generateVehicleExpensesPdf({
      company: settings.data,
      period,
      printedBy: me.data,
      vehicles: sheets,
      filename:
        gs.length === 1
          ? `vehicle-expenses-${gs[0].plate}-${from}-to-${to}`
          : `vehicle-expenses-${from}-to-${to}`,
    });
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["maintenance-vehicle-expenses"] });
    qc.invalidateQueries({ queryKey: ["maintenance-expenses"] });
  };

  const resetSheet = () => {
    setSheet({ vehicle_id: "", expense_date: localDay(), driver_name: "", payment_method: "Cash" });
    setParts([blankLine("VEHICLE MAINT.")]);
    setFuel([blankLine("FUEL")]);
  };

  const filled = (l: DraftLine, kind: "part" | "fuel") =>
    kind === "fuel" ? n0(l.quantity) > 0 || l.amount > 0 : !!l.description.trim() || l.amount > 0;
  const partsOut = parts.filter((l) => filled(l, "part"));
  const fuelOut = fuel.filter((l) => filled(l, "fuel"));
  const sheetProblem = !sheet.vehicle_id
    ? "Choose the vehicle"
    : partsOut.length + fuelOut.length === 0
      ? "Enter at least one line"
      : partsOut.some((l) => !l.description.trim())
        ? "Every particulars line needs a description"
        : fuelOut.some((l) => n0(l.quantity) <= 0)
          ? "Every fuel line needs the litres"
          : [...partsOut, ...fuelOut].some((l) => l.amount <= 0)
            ? "Every line needs an amount"
            : null;
  const draftParts = partsOut.reduce((s, l) => s + l.amount, 0);
  const draftFuel = fuelOut.reduce((s, l) => s + l.amount, 0);
  const draftLitres = fuelOut.reduce((s, l) => s + n0(l.quantity), 0);

  const saveSheet = useMutation({
    mutationFn: async () => {
      const out = (l: DraftLine, kind: "part" | "fuel") => ({
        kind,
        category: l.category,
        description: l.description.trim(),
        quantity: l.quantity === "" ? null : n0(l.quantity),
        unit_price: l.unit_price || null,
        amount: l.amount,
      });
      const { data, error } = await db.rpc("save_vehicle_expenses", {
        payload: {
          factory_id: factoryId,
          ...sheet,
          lines: [...partsOut.map((l) => out(l, "part")), ...fuelOut.map((l) => out(l, "fuel"))],
        },
      });
      if (error) throw error;
      return data as { lines: number; total: number };
    },
    onSuccess: (res) => {
      const plate = vehicleById.get(sheet.vehicle_id)?.plate_number ?? "";
      toast.success(`${plate}: ${res.lines} line(s) recorded, ${money(res.total)}`);
      logAudit({
        action: "create",
        entity: "maintenance_expenses",
        factoryId,
        newValue: { ...sheet, parts: partsOut, fuel: fuelOut },
      });
      invalidate();
      setOpen(false);
      resetSheet();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveEdit = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const { error } = await db.rpc("save_maintenance_expense", {
        payload: {
          id: editing.id,
          factory_id: factoryId,
          expense_date: edit.expense_date,
          category: edit.category,
          description: edit.description,
          amount: edit.amount,
          driver_name: edit.driver_name,
          quantity: edit.quantity === "" ? null : n0(edit.quantity),
          unit_price: edit.unit_price || null,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${editing?.expense_number} updated`);
      logAudit({
        action: "update",
        entity: "maintenance_expenses",
        entityId: editing?.id,
        factoryId,
        oldValue: editing,
        newValue: edit,
      });
      invalidate();
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (l: Line) => {
      const { error } = await db.rpc("delete_maintenance_expense", { p_id: l.id });
      if (error) throw error;
      return l;
    },
    onSuccess: (l) => {
      toast.success(`${l.expense_number} removed`);
      logAudit({
        action: "delete",
        entity: "maintenance_expenses",
        entityId: l.id,
        factoryId,
        oldValue: l,
      });
      invalidate();
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openEdit = (l: Line) => {
    setEditing(l);
    setEdit({
      expense_date: l.expense_date,
      category: l.category,
      description: l.description ?? "",
      quantity: l.quantity == null ? "" : String(Number(l.quantity)),
      unit_price: n0(l.unit_price),
      amount: n0(l.amount),
      driver_name: l.driver_name ?? "",
    });
  };

  // Qty x price fills the amount until the amount is typed over (the sheet's
  // own amounts don't always equal litres x price).
  const updateLine = (
    set: React.Dispatch<React.SetStateAction<DraftLine[]>>,
    key: number,
    patch: Partial<DraftLine>,
  ) =>
    set((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        if (!next.amountTouched && ("quantity" in patch || "unit_price" in patch)) {
          const q = n0(next.quantity);
          if (q && next.unit_price) next.amount = Math.round(q * next.unit_price * 100) / 100;
        }
        return next;
      }),
    );

  const lineActions = (l: Line) => (
    <TableCell className="whitespace-nowrap text-right">
      {canEdit && l.approval_status !== "approved" && (
        <Button size="icon" variant="ghost" title="Edit" onClick={() => openEdit(l)}>
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      {canDelete && l.approval_status !== "approved" && (
        <Button size="icon" variant="ghost" title="Delete" onClick={() => setDeleting(l)}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      )}
    </TableCell>
  );

  const draftRows = (
    kind: "part" | "fuel",
    rows: DraftLine[],
    set: React.Dispatch<React.SetStateAction<DraftLine[]>>,
  ) => (
    <div className="space-y-2">
      {rows.map((l) => (
        <div key={l.key} className="grid grid-cols-12 items-end gap-2">
          {kind === "part" ? (
            <>
              <div className="col-span-12 space-y-1 sm:col-span-4">
                <Label className="text-xs">Particulars</Label>
                <Input
                  value={l.description}
                  placeholder="e.g. Oil filter for servicing"
                  onChange={(e) => updateLine(set, l.key, { description: e.target.value })}
                />
              </div>
              <div className="col-span-6 space-y-1 sm:col-span-2">
                <Label className="text-xs">Head</Label>
                <Select
                  value={l.category}
                  onValueChange={(v) => updateLine(set, l.key, { category: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MAINTENANCE_EXPENSE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-6 space-y-1 sm:col-span-1">
                <Label className="text-xs">Qty</Label>
                <Input
                  type="number"
                  min={0}
                  value={l.quantity}
                  onChange={(e) => updateLine(set, l.key, { quantity: e.target.value })}
                />
              </div>
            </>
          ) : (
            <div className="col-span-6 space-y-1 sm:col-span-4">
              <Label className="text-xs">Litres</Label>
              <Input
                type="number"
                min={0}
                value={l.quantity}
                onChange={(e) => updateLine(set, l.key, { quantity: e.target.value })}
              />
            </div>
          )}
          <div
            className={`space-y-1 ${kind === "part" ? "col-span-5 sm:col-span-2" : "col-span-6 sm:col-span-3"}`}
          >
            <Label className="text-xs">{kind === "fuel" ? "Price / litre" : "Unit price"}</Label>
            <MoneyInput
              value={l.unit_price}
              onChange={(v) => updateLine(set, l.key, { unit_price: v })}
            />
          </div>
          <div
            className={`space-y-1 ${kind === "part" ? "col-span-5 sm:col-span-2" : "col-span-10 sm:col-span-4"}`}
          >
            <Label className="text-xs">Amount (₦)</Label>
            <MoneyInput
              value={l.amount}
              onChange={(v) => updateLine(set, l.key, { amount: v, amountTouched: true })}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Button
              size="icon"
              variant="ghost"
              title="Remove line"
              disabled={rows.length === 1}
              onClick={() => set((ls) => ls.filter((x) => x.key !== l.key))}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => set((ls) => [...ls, blankLine(kind === "fuel" ? "FUEL" : "VEHICLE MAINT.")])}
      >
        <Plus className="mr-1 h-4 w-4" /> Add {kind === "fuel" ? "fuel" : "particulars"} line
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          </div>
          <Select value={vehicleFilter} onValueChange={setVehicleFilter}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All vehicles</SelectItem>
              {vehicles.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.plate_number}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={groups.length === 0} onClick={() => print(groups)}>
            <Printer className="mr-2 h-4 w-4" />
            {groups.length > 1 ? "Print all vehicles" : "Print"}
          </Button>
          {canCreate && (
            <Button
              onClick={() => {
                resetSheet();
                if (vehicleFilter !== "all") setSheet((s) => ({ ...s, vehicle_id: vehicleFilter }));
                setOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> Record vehicle expenses
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total ({period})
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{money(grandTotal)}</CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Fuel</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {money(groups.reduce((s, g) => s + g.fuelTotal, 0))}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              {plain(totalLitres)} litres
            </span>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Parts & servicing
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {money(groups.reduce((s, g) => s + g.partsTotal, 0))}
          </CardContent>
        </Card>
      </div>

      {groups.length === 0 && (
        <Card className="rounded-2xl">
          <CardContent className="py-10 text-center text-muted-foreground">
            {lines.isLoading
              ? "Loading…"
              : vehicles.length === 0
                ? "Add your vehicles on the Vehicles tab first."
                : "No vehicle expenses in this period"}
          </CardContent>
        </Card>
      )}

      {groups.map((g) => (
        <Card key={g.id} className="rounded-2xl">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
            <div>
              <CardTitle className="text-base">
                {g.plate}
                {g.drivers && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {g.drivers}
                  </span>
                )}
              </CardTitle>
              {g.model && <div className="text-xs text-muted-foreground">{g.model}</div>}
            </div>
            <Button size="sm" variant="outline" onClick={() => print([g])}>
              <Printer className="mr-2 h-4 w-4" /> Print
            </Button>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Date</TableHead>
                  <TableHead>Particulars</TableHead>
                  <TableHead>Head</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.parts.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap">{fmtDate(l.expense_date)}</TableCell>
                    <TableCell>{lineText(l)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {l.category}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {money(l.amount)}
                    </TableCell>
                    {lineActions(l)}
                  </TableRow>
                ))}
                {g.parts.length > 0 && (
                  <TableRow className="bg-muted/50 font-semibold">
                    <TableCell colSpan={3} className="text-center">
                      Total
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {money(g.partsTotal)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )}
                {g.fuel.length > 0 && (
                  <>
                    <TableRow>
                      <TableCell colSpan={5} className="text-center font-semibold">
                        <Fuel className="mr-1 inline h-4 w-4" /> Fuel used
                      </TableCell>
                    </TableRow>
                    {g.fuel.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="whitespace-nowrap">
                          {fmtDate(l.expense_date)}
                        </TableCell>
                        <TableCell>{lineText(l)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {l.category}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {money(l.amount)}
                        </TableCell>
                        {lineActions(l)}
                      </TableRow>
                    ))}
                    <TableRow className="bg-muted/50 font-semibold">
                      <TableCell colSpan={3} className="text-center">
                        Total fuel used ({plain(g.litres)} litres)
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {money(g.fuelTotal)}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </>
                )}
                <TableRow className="bg-muted font-bold">
                  <TableCell colSpan={3}>Total</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {money(g.partsTotal + g.fuelTotal)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetSheet();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Record vehicle expenses</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1 sm:col-span-2">
              <Label>Vehicle</Label>
              <Select
                value={sheet.vehicle_id}
                onValueChange={(v) => setSheet({ ...sheet, vehicle_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose vehicle" />
                </SelectTrigger>
                <SelectContent>
                  {vehicles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.plate_number}
                      {v.make_model ? ` — ${v.make_model}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={sheet.expense_date}
                max={localDay()}
                onChange={(e) => setSheet({ ...sheet, expense_date: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Driver(s)</Label>
              <Input
                value={sheet.driver_name}
                placeholder="e.g. James/Emma"
                onChange={(e) => setSheet({ ...sheet, driver_name: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Paid by</Label>
              <Select
                value={sheet.payment_method}
                onValueChange={(v) => setSheet({ ...sheet, payment_method: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Particulars</span>
              <span>{money(draftParts)}</span>
            </div>
            {draftRows("part", parts, setParts)}
          </div>

          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Fuel used ({plain(draftLitres)} litres)</span>
              <span>{money(draftFuel)}</span>
            </div>
            {draftRows("fuel", fuel, setFuel)}
          </div>

          <div className="flex items-center justify-between border-t pt-3 text-base font-bold">
            <span>Total</span>
            <span>{money(draftParts + draftFuel)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Qty × price fills the amount; type over it if the receipt says otherwise. Empty lines
            are skipped.
          </p>

          <DialogFooter className="items-center gap-2">
            {sheetProblem && (
              <span className="mr-auto text-xs text-muted-foreground">{sheetProblem}</span>
            )}
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!!sheetProblem || saveSheet.isPending}
              onClick={() => saveSheet.mutate()}
            >
              {saveSheet.isPending ? "Saving…" : "Record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Edit {editing?.line_kind === "fuel" ? "fuel" : "particulars"} line
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={edit.expense_date}
                  max={localDay()}
                  onChange={(e) => setEdit({ ...edit, expense_date: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Driver(s)</Label>
                <Input
                  value={edit.driver_name}
                  onChange={(e) => setEdit({ ...edit, driver_name: e.target.value })}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>{editing.line_kind === "fuel" ? "Note (optional)" : "Particulars"}</Label>
                <Input
                  value={edit.description}
                  onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                />
              </div>
              {editing.line_kind !== "fuel" && (
                <div className="space-y-1 sm:col-span-2">
                  <Label>Head</Label>
                  <Select
                    value={edit.category}
                    onValueChange={(v) => setEdit({ ...edit, category: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MAINTENANCE_EXPENSE_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label>{editing.line_kind === "fuel" ? "Litres" : "Qty"}</Label>
                <Input
                  type="number"
                  min={0}
                  value={edit.quantity}
                  onChange={(e) => setEdit({ ...edit, quantity: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>{editing.line_kind === "fuel" ? "Price / litre" : "Unit price"}</Label>
                <MoneyInput
                  value={edit.unit_price}
                  onChange={(v) => setEdit({ ...edit, unit_price: v })}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Amount (₦)</Label>
                <MoneyInput value={edit.amount} onChange={(v) => setEdit({ ...edit, amount: v })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                saveEdit.isPending ||
                edit.amount <= 0 ||
                (editing?.line_kind === "fuel" ? n0(edit.quantity) <= 0 : !edit.description.trim())
              }
              onClick={() => saveEdit.mutate()}
            >
              {saveEdit.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete line?</DialogTitle>
          </DialogHeader>
          {deleting && (
            <p className="text-sm">
              {vehicleById.get(deleting.vehicle_id)?.plate_number}: {lineText(deleting)},{" "}
              {money(deleting.amount)} on {fmtDate(deleting.expense_date)}. This cannot be undone.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
