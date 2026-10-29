import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReportActions } from "@/components/shared/report-actions";
import { IssuesTab } from "@/components/preform/issues";
import { TransfersTab } from "@/components/preform/transfers";
import { CountInput } from "@/components/preform/shared";
import {
  rpc,
  useDailyReport,
  useDaySummary,
  useIssues,
  useMyUserId,
  usePfAction,
  useTransfers,
  type DailyRow,
} from "@/components/preform/api";
import { formatBags, formatPieces, splitBags } from "@/lib/preform-units";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { usePermissions } from "@/lib/permissions";

// Quality Control → Preforms: QC's preform store, end to end.
//   1. Received from Store -- preforms the Store issues to QC (Store → Issue
//      Stock / Issue preforms) wait here for her to accept them.
//   2. Process preforms -- where QC blows them: one row per preform over a date range, as the
//      factory's printed "Preform Report from … to …" sheet. She enters each
//      day's blowing (the pencil): Blown (every bottle blown) and Damages (the
//      bad ones). That records and submits a blowing shift
//      (save_preform_shift / submit_preform_shift), so the good bottles
//      (Expected Bottles = Blown − Damages) go straight into stock and the
//      damage stays on record only.
//   3. Send to PM -- the good bottles go to production, which confirms them.
// Figures: preform_daily_report.

type Row = {
  material_id: string;
  material: string;
  brand: string | null;
  pieces_per_bag: number | null;
  opening: number;
  received: number;
  blown: number;
  damages: number;
  balance: number;
  shifts: number;
  // Who holds this preform at the end of the range (each QC person has her
  // own preform stock).
  holders: { operator_id: string; operator: string; closing: number }[];
};

// The bottle types QC blows (Bottle type box on each blowing entry).
const BOTTLE_SIZES = ["35cl", "50cl", "75cl", "100cl", "150cl"] as const;

const label = (r: Row) => (r.brand ? `${r.material} (${r.brand})` : r.material);
const fromStore = (r: Row) => {
  const s = splitBags(r.received, r.pieces_per_bag);
  return s ? formatBags(s) : `${num(r.received)} pcs`;
};

type Step = "received" | "report" | "send";

export function QcPreformsPanel({ factoryId }: { factoryId: string }) {
  const me = useMyUserId();
  const myIssues = useIssues(factoryId, { status: "issued" });
  const waitingIssues = (myIssues.data ?? []).filter((i) => i.operator_id === me.data).length;
  const transfers = useTransfers(factoryId);
  const inTransit = (transfers.data ?? []).filter((t) => t.status === "dispatched").length;
  const [step, setStep] = useState<Step>("report");

  const count = (n: number) =>
    n ? (
      <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">
        {n}
      </Badge>
    ) : null;

  return (
    <div className="space-y-4">
      <Tabs value={step} onValueChange={(v) => setStep(v as Step)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="received">1. Received from Store{count(waitingIssues)}</TabsTrigger>
          <TabsTrigger value="report">2. Process preforms</TabsTrigger>
          <TabsTrigger value="send">3. Send to PM{count(inTransit)}</TabsTrigger>
        </TabsList>
        <p className="mt-2 text-sm text-muted-foreground">
          Accept the preforms the Store issues you → enter what was blown and what was damaged → the
          good bottles go into stock (damage is kept on record) → send them to PM, who confirms what
          it receives.
        </p>
        <TabsContent value="received">
          <IssuesTab factoryId={factoryId} receiveOnly />
        </TabsContent>
        <TabsContent value="report">
          <PreformReport factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="send">
          <TransfersTab factoryId={factoryId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PreformReport({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canRecord = can("preform-production", "create");
  const today = localDay();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [editing, setEditing] = useState<Row | null>(null);
  const report = useDailyReport(factoryId, from, to);

  // Brand + grammage, as "Preform 29mm (Prima-16.5g)" on the sheet.
  const ids = [...new Set((report.data ?? []).map((r) => r.material_id))];
  const brands = useQuery({
    queryKey: ["qc-preforms", "brands", ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("raw_materials")
        .select("id,brands(name,grammage)")
        .in("id", ids);
      return new Map(
        ((data ?? []) as { id: string; brands: { name: string; grammage: string | null } | null }[])
          .filter((m) => m.brands)
          .map((m) => [
            m.id,
            `${m.brands!.name}${m.brands!.grammage ? `-${m.brands!.grammage}` : ""}`,
          ]),
      );
    },
  });

  // One row per preform over the range, every blower's figures added up. The
  // report has a row per day: Opening is the first day's, Balance the last
  // day's closing, the rest are summed.
  const byMaterial = new Map<string, Row>();
  for (const r of (report.data ?? []) as DailyRow[]) {
    const row = byMaterial.get(r.material_id) ?? {
      material_id: r.material_id,
      material: r.material,
      brand: brands.data?.get(r.material_id) ?? null,
      pieces_per_bag: r.pieces_per_bag,
      opening: 0,
      received: 0,
      blown: 0,
      damages: 0,
      balance: 0,
      shifts: 0,
      holders: [],
    };
    if (r.day === from) row.opening += r.opening;
    if (r.day === to) {
      row.balance += r.closing;
      row.holders.push({ operator_id: r.operator_id, operator: r.operator, closing: r.closing });
    }
    row.received += r.received;
    row.blown += r.usage;
    row.damages += r.damaged_preforms + r.damaged_bottles + r.other_losses;
    row.shifts += r.shifts;
    byMaterial.set(r.material_id, row);
  }
  const rows = [...byMaterial.values()]
    .filter((r) => r.opening || r.received || r.blown || r.balance)
    .sort((a, b) => label(a).localeCompare(label(b)));
  // As on the printed sheet: Expected Bottles = Blown − Damages, Balance =
  // Total − Blown (Total = Opening + From Store).
  const expected = (r: Row) => r.blown - r.damages;
  const sheetBalance = (r: Row) => r.opening + r.received - r.blown;
  const title = `Quality Control Department: Preform Report from ${from} to ${to}`;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Total = Opening + From Store · Expected Bottles = Blown − Damages (they go into stock) ·
            Balance = Total − Blown. Enter each day&rsquo;s blowing with ✎.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <ReportActions
            size="sm"
            title={title}
            fileName={`qc-preform-report-${from}-to-${to}`}
            columns={[
              { key: "sn", label: "S/N" },
              { key: "material", label: "Material" },
              { key: "fromStore", label: "From Store" },
              { key: "pieces", label: "Pieces" },
              { key: "opening", label: "Opening" },
              { key: "total", label: "Total" },
              { key: "blown", label: "Blown" },
              { key: "damages", label: "Damages" },
              { key: "expected", label: "Expected Bottles" },
              { key: "balance", label: "Balance" },
            ]}
            rows={rows.map((r, i) => ({
              sn: i + 1,
              material: label(r),
              fromStore: fromStore(r),
              pieces: r.pieces_per_bag ? num(r.pieces_per_bag) : "—",
              opening: num(r.opening),
              total: num(r.opening + r.received),
              blown: num(r.blown),
              damages: num(r.damages),
              expected: num(expected(r)),
              balance: num(sheetBalance(r)),
            }))}
          />
          <div>
            <Label htmlFor="qc-preforms-from" className="text-xs">
              From
            </Label>
            <Input
              id="qc-preforms-from"
              type="date"
              className="h-9 w-40"
              value={from}
              max={to}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="qc-preforms-to" className="text-xs">
              To
            </Label>
            <Input
              id="qc-preforms-to"
              type="date"
              className="h-9 w-40"
              value={to}
              min={from}
              max={today}
              onChange={(e) => e.target.value && setTo(e.target.value)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">S/N</TableHead>
              <TableHead>Material</TableHead>
              <TableHead>From Store</TableHead>
              <TableHead>Pieces</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Blown</TableHead>
              <TableHead className="text-right">Damages</TableHead>
              <TableHead className="text-right">Expected Bottles</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              {canRecord && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.material_id}>
                <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                <TableCell className="font-medium">{label(r)}</TableCell>
                <TableCell>{fromStore(r)}</TableCell>
                <TableCell>{r.pieces_per_bag ? num(r.pieces_per_bag) : "—"}</TableCell>
                <TableCell className="text-right">{num(r.opening)}</TableCell>
                <TableCell className="text-right">{num(r.opening + r.received)}</TableCell>
                <TableCell className="text-right">{num(r.blown)}</TableCell>
                <TableCell className="text-right text-destructive">{num(r.damages)}</TableCell>
                <TableCell className="text-right">{num(expected(r))}</TableCell>
                <TableCell className="text-right font-medium">{num(sheetBalance(r))}</TableCell>
                {canRecord && (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Enter blown and damages"
                      aria-label="Enter blown and damages"
                      disabled={r.balance <= 0}
                      onClick={() => setEditing(r)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                  {report.isLoading
                    ? "Loading…"
                    : report.isError
                      ? (report.error as Error).message
                      : "No preforms with Quality Control in this period."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      {editing && (
        <BlowingDialog
          factoryId={factoryId}
          row={editing}
          rangeFrom={from}
          rangeTo={to}
          label={label(editing)}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

// The day's blowing for one preform: Blown (total bottles blown, good and
// damaged -- one preform each) and Damages (the bad bottles). Recorded and
// submitted as a blowing shift for the QC person who holds the preforms --
// you, unless someone else holds them (entering it for another person needs
// a manager's right, as before).
function BlowingDialog({
  factoryId,
  row,
  rangeFrom,
  rangeTo,
  label,
  onClose,
}: {
  factoryId: string;
  row: Row;
  rangeFrom: string;
  rangeTo: string;
  label: string;
  onClose: () => void;
}) {
  const me = useMyUserId();
  const [day, setDay] = useState(rangeTo);
  // A preform is not tied to a bottle: the bottle type is picked by hand on
  // every entry (20261023235900), from all the factory's bottle types.
  const products = useQuery({
    queryKey: ["qc-preforms", "products", factoryId],
    queryFn: async () => {
      const { data } = await supabase
        .from("products")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  // Bottle types only (35cl, 50cl, 75cl, 150cl bottles...); every product if
  // the factory has none named so yet.
  const bottleTypes = (() => {
    const all = products.data ?? [];
    const bottles = all.filter((p) => /bottle|\d+\s*cl\b/i.test(p.name));
    const list = bottles.length ? bottles : all;
    const size = (n: string) => Number(/(\d+)\s*cl/i.exec(n)?.[1] ?? 9999);
    return [...list].sort((a, b) => size(a.name) - size(b.name) || a.name.localeCompare(b.name));
  })();
  // This entry's bottle type: one of the factory's four sizes, picked by hand
  // (nothing preselected). The good bottles go into the existing bottle of
  // that size (e.g. 50cl → "50cl Bottle Water"), or "<size> Bottle" is added
  // (set_shift_bottle_by_name, 20261024000000).
  const [bottleSize, setBottleSize] = useState("");
  const sizeBottle = (size: string) =>
    bottleTypes.find((p) => new RegExp(`\\b${size.replace("cl", "")}\\s*cl\\b`, "i").test(p.name));
  const existingBottle = bottleSize ? sizeBottle(bottleSize) : undefined;
  const typedName = bottleSize ? (existingBottle?.name ?? `${bottleSize} Bottle`) : "";
  // Those holding this preform, most first; you first if you hold some.
  const holders = [...row.holders]
    .filter((h) => h.closing > 0 || h.operator_id === me.data)
    .sort((a, b) => b.closing - a.closing);
  const [chosen, setChosen] = useState("");
  const operatorId =
    chosen ||
    (holders.some((h) => h.operator_id === me.data && h.closing > 0)
      ? (me.data ?? "")
      : (holders[0]?.operator_id ?? me.data ?? ""));
  const operatorName =
    operatorId === me.data
      ? "You hold"
      : `${holders.find((h) => h.operator_id === operatorId)?.operator ?? "They"} holds`;
  const summary = useDaySummary(operatorId, row.material_id, day);
  const held = summary.data?.held_now ?? 0;
  // What is already entered for this preform on the day picked.
  const dayBlown = summary.data
    ? summary.data.good_bottles +
      summary.data.damaged_preforms +
      summary.data.damaged_bottles +
      summary.data.other_losses
    : 0;
  const dayDamages = summary.data
    ? summary.data.damaged_preforms + summary.data.damaged_bottles + summary.data.other_losses
    : 0;
  const [shift, setShift] = useState<"day" | "night">("day");
  // One blowing session per dialog: a retried or double-clicked save posts it
  // once (save_preform_shift client_ref, 20261025090000). Several sessions in
  // one shift are separate entries.
  const [clientRef] = useState(() => crypto.randomUUID());
  const [blown, setBlown] = useState<number | null>(null);
  const [damages, setDamages] = useState<number | null>(null);
  const b = blown ?? 0;
  const d = damages ?? 0;
  const good = b - d;
  const total = row.opening + row.received;
  const totalBlown = row.blown + b;
  const totalDamages = row.damages + d;
  const problem =
    d > b
      ? "Damages cannot be more than blown"
      : b > held
        ? `${operatorName} ${num(held)} of this preform — blown cannot be more`
        : null;

  const save = usePfAction(
    async () => {
      if (!typedName) throw new Error("Select the bottle type");
      // A draft left by an earlier attempt (e.g. one that stopped for want of
      // a bottle) is completed rather than duplicated.
      const { data: drafts } = await supabase
        .from("preform_shift_records" as never)
        .select("id")
        .eq("operator_id", operatorId)
        .eq("material_id", row.material_id)
        .eq("production_date", day)
        .eq("shift", shift)
        .eq("status", "draft")
        .limit(1);
      const r = await rpc<{ id: string; status: string; duplicate?: boolean }>(
        "save_preform_shift",
        {
          payload: {
            id: ((drafts ?? []) as { id: string }[])[0]?.id ?? null,
            client_ref: clientRef,
            operator_id: operatorId,
            material_id: row.material_id,
            production_date: day,
            shift,
            good_bottles: good,
            damaged_bottles: d,
          },
        },
      );
      // Already posted by an earlier click: nothing more to do.
      if (r.duplicate && r.status !== "draft") return { status: r.status, duplicate: true };
      // This entry's good bottles go into the bottle type picked
      // (set_shift_bottle, 20261023235800).
      await rpc("set_shift_bottle_by_name", { p_record: r.id, p_name: typedName });
      return rpc<{ status: string; stocked?: number }>("submit_preform_shift", { p_id: r.id });
    },
    (r) => {
      const x = r as { status: string; stocked?: number; duplicate?: boolean };
      if (x?.duplicate) return "Already recorded — nothing posted twice";
      return x?.status === "completed"
        ? `Recorded — ${num(x.stocked ?? 0)} good bottles stocked; damage recorded`
        : "Recorded — waiting for QC";
    },
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Blowing — {label}</DialogTitle>
          <DialogDescription>
            {day}. {operatorName} {summary.isLoading ? "…" : num(held)} pieces of this preform.
            {dayBlown > 0 &&
              ` Already entered on ${day}: ${num(dayBlown)} blown, ${num(dayDamages)} damaged — this adds another session.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label htmlFor="qc-blowing-day">Date blown</Label>
            <Input
              id="qc-blowing-day"
              type="date"
              value={day}
              min={rangeFrom}
              max={rangeTo}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
          </div>
          {(holders.length > 1 || (holders[0] && holders[0].operator_id !== me.data)) && (
            <div>
              <Label>Blown by</Label>
              <Select value={operatorId} onValueChange={setChosen}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {holders.map((h) => (
                    <SelectItem key={h.operator_id} value={h.operator_id}>
                      {h.operator_id === me.data ? "Me" : h.operator} — holds {num(h.closing)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Shift</Label>
            <Select value={shift} onValueChange={(v) => setShift(v as "day" | "night")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Day</SelectItem>
                <SelectItem value="night">Night</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Blown (all bottles blown, good and bad)</Label>
              <CountInput value={blown} onChange={setBlown} placeholder="0" />
            </div>
            <div>
              <Label>Damages (bad bottles)</Label>
              <CountInput value={damages} onChange={setDamages} placeholder="0" />
            </div>
          </div>
          <div>
            <Label>Bottle type *</Label>
            <Select value={bottleSize} onValueChange={setBottleSize}>
              <SelectTrigger>
                <SelectValue placeholder="Select the bottle type" />
              </SelectTrigger>
              <SelectContent>
                {BOTTLE_SIZES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bottleSize && !existingBottle && !products.isLoading && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                No {bottleSize} bottle in stock yet — &ldquo;{typedName}&rdquo; will be added when
                you save.
              </p>
            )}
          </div>
          {/* The report line as it will read once this is saved, worked out
              as on the printed sheet: Total = From Store (bags × pieces) +
              Opening, Expected Bottles = Blown − Damages, Balance = Total −
              Blown. Blown and Damages include what is already entered for
              the period. */}
          <div className="rounded-md bg-muted/40 p-2 text-sm">
            <div className="mb-1 text-[11px] text-muted-foreground">
              Report {rangeFrom} to {rangeTo}, with this entry
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">
                From Store
                {row.pieces_per_bag ? ` (${fromStore(row)} × ${num(row.pieces_per_bag)})` : ""}
              </dt>
              <dd className="text-right">{num(row.received)}</dd>
              <dt className="text-muted-foreground">+ Opening</dt>
              <dd className="text-right">{num(row.opening)}</dd>
              <dt className="font-medium">= Total</dt>
              <dd className="text-right font-medium">{num(total)}</dd>
              <dt className="text-muted-foreground">Blown</dt>
              <dd className="text-right">{num(totalBlown)}</dd>
              <dt className="text-muted-foreground">Damages</dt>
              <dd className="text-right text-destructive">{num(totalDamages)}</dd>
              <dt className="font-medium">Expected Bottles (Blown − Damages)</dt>
              <dd className="text-right text-lg font-semibold">{num(totalBlown - totalDamages)}</dd>
              <dt className="font-medium">Balance (Total − Blown)</dt>
              <dd className="text-right text-lg font-semibold">{num(total - totalBlown)}</dd>
            </dl>
            {b > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                This entry: {num(b)} blown − {num(d)} damaged = {num(Math.max(good, 0))} good
                bottles into {typedName || "stock"}.
              </p>
            )}
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
          <p className="text-[11px] text-muted-foreground">
            Once saved, the good bottles are in stock. A mistake is corrected by a manager reversing
            the entry (Good bottles → Record blowing). Damages stay on record.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!blown || !!problem || save.isPending || !operatorId || !bottleSize}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
