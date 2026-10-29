import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, Pencil, Plus, Printer, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useFactorySettings } from "@/lib/use-factory";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { generateReportPdf } from "@/lib/pdf";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ReportRow = {
  id: string;
  report_date: string;
  material_name: string;
  unit: string | null;
  opening: number;
  qty_in: number;
  total: number;
  qty_used: number;
  damages: number;
  replaced: number;
  balance: number;
  remarks: string | null;
  created_by_name: string | null;
  created_at: string;
};
// kind 'bottle': a blown bottle QC sends to the PM (20261029110000) -- her
// raw material for Bottle Water; received_since = bottles received from QC
// after its last line, the Qty In a new line starts with.
type MaterialOption = {
  material_id: string;
  material_name: string;
  unit: string;
  last_balance: number;
  detail: string | null;
  kind: "material" | "bottle";
  received_since: number;
};
type Line = {
  key: number;
  material_id: string;
  kind?: "material" | "bottle";
  opening: number;
  qty_in: number;
  qty_used: number;
  damages: number;
  replaced: number;
};

// A bottle's size in cl from its name ("35cl Bottle", "1.5Ltr Bottle (150cl)").
const bottleCl = (name: string) => {
  const cl = /(\d+(?:\.\d+)?)\s*cl\b/i.exec(name);
  if (cl) return Number(cl[1]);
  const ltr = /(\d+(?:\.\d+)?)\s*l(?:tr|itre)?\b/i.exec(name);
  return ltr ? Number(ltr[1]) * 100 : 9999;
};

// Qty Used is everything used, the damaged included; Damages is the part of
// it that was spoiled (20261029200000).
const balanceOf = (l: Omit<Line, "key" | "material_id">) =>
  l.opening + l.qty_in - l.qty_used + l.replaced;

// Production → Process Material: the Production Manager's register of the raw
// materials she works with (as the factory's paper "All Process Material"):
// Opening, Qty In, Total, Qty Used, Damages, Balance per material, added with
// "Add New Process Material" and corrected with Edit.
export function ProductionMaterialsReport({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canAdd = can("production", "create");
  const canEdit = canAdd || can("production", "edit");
  const settings = useFactorySettings(factoryId);
  const [date, setDate] = useState(localDay());
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ReportRow | null>(null);

  const rows = useQuery({
    queryKey: ["production-material-reports", factoryId, date],
    queryFn: async () => {
      let query = supabase
        .from("production_material_reports" as never)
        .select(
          "id,report_date,material_name,unit,opening,qty_in,total,qty_used,damages,replaced,balance,remarks,created_by_name,created_at",
        )
        .eq("factory_id", factoryId);
      if (date) query = query.eq("report_date", date);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as ReportRow[];
    },
  });

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = rows.data ?? [];
    return term ? all.filter((r) => r.material_name.toLowerCase().includes(term)) : all;
  }, [rows.data, q]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["production-material-reports"] });
    qc.invalidateQueries({ queryKey: ["production-material-options"] });
  };

  const pdf = (action: "download" | "print") =>
    generateReportPdf(
      "All Process Material",
      [
        { key: "sn", label: "S/N" },
        { key: "material", label: "Material" },
        { key: "opening", label: "Opening" },
        { key: "qty_in", label: "Qty In" },
        { key: "total", label: "Total" },
        { key: "qty_used", label: "Qty Used" },
        { key: "damages", label: "Damages" },
        { key: "balance", label: "Balance" },
        { key: "at", label: "Date/Time" },
      ],
      shown.map((r, i) => ({
        sn: i + 1,
        material: r.material_name,
        opening: num(Number(r.opening)),
        qty_in: num(Number(r.qty_in)),
        total: num(Number(r.total)),
        qty_used: num(Number(r.qty_used)),
        damages: num(Number(r.damages)),
        balance: num(Number(r.balance)),
        at: new Date(r.created_at).toLocaleString(),
      })),
      action,
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      [date ? `Date: ${date}` : "All dates"],
    );

  return (
    <div className="space-y-4">
      {canAdd && (
        <Button className="gap-2" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add New Process Material
        </Button>
      )}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>All Process Material</CardTitle>
          <p className="text-sm text-muted-foreground">List of all materials and actions</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Button
              variant="outline"
              className="gap-2"
              disabled={!shown.length}
              onClick={() => void pdf("download")}
            >
              <FileDown className="h-4 w-4" /> Generate report
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              disabled={!shown.length}
              onClick={() => void pdf("print")}
            >
              <Printer className="h-4 w-4" /> Print view
            </Button>
            <div className="relative ml-auto w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search material…"
                className="h-9 pl-8"
              />
            </div>
            <div>
              <Label className="text-xs">Filter by date</Label>
              <div className="flex gap-1">
                <Input
                  type="date"
                  value={date}
                  max={localDay()}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-9"
                />
                <Button variant="ghost" size="sm" onClick={() => setDate("")}>
                  All
                </Button>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>S/N</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Qty In</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Qty Used</TableHead>
                  <TableHead className="text-right">Damages</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Date/Time</TableHead>
                  {canEdit && <TableHead>Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r, i) => (
                  <TableRow key={r.id}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell className="font-medium">{r.material_name}</TableCell>
                    <TableCell className="text-right">{num(Number(r.opening))}</TableCell>
                    <TableCell className="text-right">{num(Number(r.qty_in))}</TableCell>
                    <TableCell className="text-right">{num(Number(r.total))}</TableCell>
                    <TableCell className="text-right">{num(Number(r.qty_used))}</TableCell>
                    <TableCell className="text-right">{num(Number(r.damages))}</TableCell>
                    <TableCell className="text-right font-semibold">
                      {num(Number(r.balance))}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Enter quantity produced and damaged"
                          aria-label="Enter quantity produced and damaged"
                          onClick={() => setEditing(r)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {shown.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={canEdit ? 10 : 9}
                      className="py-8 text-center text-muted-foreground"
                    >
                      {rows.isLoading
                        ? "Loading…"
                        : rows.isError
                          ? (rows.error as Error).message
                          : "No process material for this date yet."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddReportDialog
            factoryId={factoryId}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        {editing && (
          <EditReportDialog
            row={editing}
            onDone={() => {
              setEditing(null);
              refresh();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function AddReportDialog({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
  const [date, setDate] = useState(localDay());
  // Opens with one material line, so the material dropdown is there at once.
  const [lines, setLines] = useState<Line[]>([
    { key: 1, material_id: "", opening: 0, qty_in: 0, qty_used: 0, damages: 0, replaced: 0 },
  ]);
  const [nextKey, setNextKey] = useState(2);
  const options = useQuery({
    queryKey: ["production-material-options", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "production_material_options" as never,
        { p_factory: factoryId } as never,
      );
      if (error) throw error;
      // Before the blown-bottles update (20261029110000) the list has no
      // kind: every option is a Store raw material.
      return ((data ?? []) as unknown as MaterialOption[]).map((o) => ({
        ...o,
        kind: o.kind ?? "material",
        received_since: Number(o.received_since ?? 0),
      }));
    },
  });
  const opts = options.data ?? [];
  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    setLines((ls) => [
      ...ls,
      {
        key: nextKey,
        material_id: "",
        opening: 0,
        qty_in: 0,
        qty_used: 0,
        damages: 0,
        replaced: 0,
      },
    ]);
    setNextKey((k) => k + 1);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (lines.length === 0) throw new Error("Add at least one material");
      if (lines.some((l) => !l.material_id)) throw new Error("Pick a material in every line");
      if (lines.some((l) => l.damages > l.qty_used))
        throw new Error("Damaged can't be more than the total Qty Used — it is part of it");
      const bad = lines.find((l) => balanceOf(l) < 0);
      if (bad) throw new Error("A balance can't go below 0 — more used than Opening + Qty In");
      const { error } = await supabase.rpc(
        "save_production_material_report" as never,
        {
          payload: {
            factory_id: factoryId,
            report_date: date,
            lines: lines.map(({ key: _key, kind, material_id, ...l }) =>
              kind === "bottle" ? { ...l, product_id: material_id } : { ...l, material_id },
            ),
          },
        } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Process material saved");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const taken = new Set(lines.map((l) => l.material_id));
  return (
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Add New Process Material</DialogTitle>
      </DialogHeader>
      <div className="max-w-xs">
        <Label>Date</Label>
        <Input
          type="date"
          value={date}
          max={localDay()}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Opening starts from the material&apos;s last balance. For blown bottles from QC, Qty In
        starts with the bottles you received from QC since the last entry. Qty Used includes the
        damaged ones; enter how many were damaged in Damages. Balance = Opening + Qty In − Qty Used.
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-48">Material</TableHead>
              <TableHead>Opening</TableHead>
              <TableHead>Qty In</TableHead>
              <TableHead>Qty Used</TableHead>
              <TableHead>Damages</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const bal = balanceOf(l);
              return (
                <TableRow key={l.key}>
                  <TableCell>
                    <Select
                      value={l.material_id}
                      onValueChange={(v) => {
                        const o = opts.find((x) => x.material_id === v);
                        update(l.key, {
                          material_id: v,
                          kind: o?.kind ?? "material",
                          opening: Number(o?.last_balance ?? 0),
                          // Bottles received from QC since the last entry.
                          qty_in: Number(o?.received_since ?? 0),
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select material…" />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          [
                            ["bottle", "Blown bottles from QC"],
                            ["material", "Store raw materials"],
                          ] as const
                        ).map(([kind, label]) => {
                          const group = opts.filter(
                            (o) =>
                              o.kind === kind &&
                              (o.material_id === l.material_id || !taken.has(o.material_id)),
                          );
                          // Bottles smallest first: 35cl, 50cl, 75cl, 1Ltr, 1.5Ltr.
                          if (kind === "bottle")
                            group.sort(
                              (a, b) => bottleCl(a.material_name) - bottleCl(b.material_name),
                            );
                          return group.length === 0 ? null : (
                            <SelectGroup key={kind}>
                              <SelectLabel>{label}</SelectLabel>
                              {group.map((o) => (
                                <SelectItem key={o.material_id} value={o.material_id}>
                                  {o.material_name}
                                  {o.kind === "bottle" && o.received_since > 0
                                    ? ` (${num(Number(o.received_since))} received)`
                                    : o.detail && o.kind !== "bottle"
                                      ? ` (${o.detail})`
                                      : ""}{" "}
                                  · {o.unit}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          );
                        })}
                        {opts.length === 0 && (
                          <div className="px-2 py-3 text-sm text-muted-foreground">
                            {options.isLoading
                              ? "Loading raw materials…"
                              : options.isError
                                ? `Can't load raw materials: ${(options.error as Error).message}`
                                : "No raw materials yet — the Store adds them on Raw Materials."}
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  {(["opening", "qty_in", "qty_used", "damages"] as const).map((k) => (
                    <TableCell key={k} className="w-28">
                      <MoneyInput
                        min={0}
                        value={l[k]}
                        onChange={(v) => update(l.key, { [k]: v })}
                      />
                    </TableCell>
                  ))}
                  <TableCell
                    className={`text-right font-semibold ${bal < 0 ? "text-destructive" : ""}`}
                  >
                    {num(bal)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Remove"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {lines.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                  Click Add material for each material.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {!options.isLoading && opts.length === 0 && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {options.isError
            ? `The materials list can't load: ${(options.error as Error).message}. Process Material needs its database update (the SQL for Production → Process Material) — ask your admin to run it.`
            : "No raw materials yet — the Store adds them on Raw Materials."}
        </p>
      )}
      <div>
        <Button variant="outline" size="sm" className="gap-2" onClick={addLine}>
          <Plus className="h-4 w-4" /> Add material
        </Button>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save report"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function EditReportDialog({ row, onDone }: { row: ReportRow; onDone: () => void }) {
  const [vals, setVals] = useState({
    opening: Number(row.opening),
    qty_in: Number(row.qty_in),
    qty_used: Number(row.qty_used),
    damages: Number(row.damages),
    replaced: Number(row.replaced),
  });
  const bal = balanceOf(vals);
  const save = useMutation({
    mutationFn: async () => {
      if (vals.damages > vals.qty_used)
        throw new Error("Damaged can't be more than the total Qty Used — it is part of it");
      if (bal < 0)
        throw new Error("The balance can't go below 0 — more used than Opening + Qty In");
      const { error } = await supabase.rpc(
        "save_production_material_report" as never,
        { payload: { id: row.id, ...vals } } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${row.material_name} updated`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const field = (k: keyof typeof vals, label: string) => (
    <div>
      <Label>{label}</Label>
      <MoneyInput min={0} value={vals[k]} onChange={(v) => setVals((s) => ({ ...s, [k]: v }))} />
    </div>
  );
  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{row.material_name}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Opening {num(vals.opening)} + Qty In {num(vals.qty_in)} = {num(vals.opening + vals.qty_in)}{" "}
        {row.unit ?? ""}. Enter the quantity used (the damaged included) and how many were damaged.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {field("qty_used", "Qty Used")}
        {field("damages", "Damages")}
      </div>
      <div className="rounded-xl border p-3">
        <div className="text-xs uppercase text-muted-foreground">Expected balance</div>
        <div className={`text-2xl font-semibold ${bal < 0 ? "text-destructive" : ""}`}>
          {num(bal)} {row.unit ?? ""}
        </div>
        <div className="text-xs text-muted-foreground">Opening + Qty In − Qty Used</div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Correct the other figures
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {field("opening", "Opening")}
          {field("qty_in", "Qty In")}
        </div>
      </details>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
