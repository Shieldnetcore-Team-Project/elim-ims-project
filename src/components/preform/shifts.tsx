import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  ClipboardPlus,
  Eye,
  Loader2,
  PackageCheck,
  Pencil,
  Send,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { SHIFT_LABEL, addDays, localDay, suggestedEntry, type Shift } from "@/lib/production-shift";
import {
  db,
  rpc,
  useDaySummary,
  useMyUserId,
  usePfAction,
  usePreformMaterials,
  usePreformOperators,
  useShiftRecord,
  useShiftReport,
  useUserNames,
  type ShiftRow,
} from "./api";
import { CountInput, Pieces, ReasonDialog, StatusBadge, fmtDate, fmtDateTime } from "./shared";

const STATUSES = [
  "draft",
  "awaiting_inspection",
  "awaiting_stocking",
  "completed",
  "reversed",
] as const;

// QC records her own blowing: submitting stocks her good bottles at once
// (20261022100000_qc_records_blowing.sql). Anyone else waits for QC.
type SubmitResult = { status: string; stocked?: number };
const submittedMessage = (r: SubmitResult) =>
  r?.status === "completed"
    ? `Shift submitted — ${num(r.stocked ?? 0)} good bottles stocked; damage recorded`
    : "Shift submitted — waiting for QC";

export function ShiftsTab({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canRecord = can("preform-production", "create") || can("preform-production", "edit");
  const canSubmit = can("preform-production", "submit");
  const isManager = can("preform-production", "reverse");
  const me = useMyUserId();
  const [from, setFrom] = useState(addDays(localDay(), -6));
  const [to, setTo] = useState(localDay());
  const [status, setStatus] = useState<string>("all");
  const rows = useShiftReport(factoryId, { from, to, status: status === "all" ? null : status });
  const materials = usePreformMaterials(factoryId);
  const perBag = (name: string) => materials.data?.find((m) => m.name === name)?.pieces_per_bag;

  const [edit, setEdit] = useState<{ id: string | null } | null>(null);
  const [view, setView] = useState<ShiftRow | null>(null);
  const [sendFor, setSendFor] = useState<ShiftRow | null>(null);
  const [act, setAct] = useState<{ kind: "shortfall" | "reverse"; row: ShiftRow } | null>(null);

  const submit = usePfAction(
    (id: string) => rpc<SubmitResult>("submit_preform_shift", { p_id: id }),
    (r) => submittedMessage(r as SubmitResult),
  );
  const send = usePfAction(
    (a: { id: string; counted: number; note: string }) =>
      rpc("send_preform_stocking", {
        p_record: a.id,
        p_counted: a.counted,
        p_note: a.note || null,
      }),
    "Sent to the Warehouse — stock rises when they accept",
  );
  const shortfall = usePfAction(
    (a: { id: string; note: string }) =>
      rpc("report_preform_shortfall", { p_record: a.id, p_note: a.note }),
    "Shortfall reported to the production manager",
  );
  const reverse = usePfAction(
    (a: { id: string; reason: string }) =>
      rpc("reverse_preform_shift", { p_id: a.id, p_reason: a.reason }),
    "Shift reversed — its preforms are back in the operator's balance",
  );

  const owns = (r: ShiftRow) => r.operator_id === me.data || isManager;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Shift records</CardTitle>
          <p className="text-sm text-muted-foreground">
            One record per operator, preform, date and shift. Submitting takes the usage out of the
            operator's balance. A shift QC blew herself stocks its good bottles at once (damage is
            recorded only); anyone else's waits for QC to approve the good bottles.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              className="w-36"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              className="w-36"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  <StatusBadge status={s} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canRecord && (
            <Button className="gap-2" onClick={() => setEdit({ id: null })}>
              <ClipboardPlus className="h-4 w-4" /> Record shift
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date / shift</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead>Preform</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Good</TableHead>
              <TableHead className="text-right">Damaged</TableHead>
              <TableHead className="text-right">Usage</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">QC good</TableHead>
              <TableHead className="text-right">Stocked</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows.data ?? []).map((r) => {
              const pb = perBag(r.material);
              const damaged = r.damaged_preforms + r.damaged_bottles + r.other_losses;
              return (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    {fmtDate(r.production_date)}
                    <div className="text-xs text-muted-foreground">
                      {SHIFT_LABEL[r.shift]} · <span className="font-mono">{r.reference}</span>
                    </div>
                  </TableCell>
                  <TableCell>{r.operator}</TableCell>
                  <TableCell>
                    {r.material}
                    {r.machine && <div className="text-xs text-muted-foreground">{r.machine}</div>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Pieces value={r.available_qty} perBag={pb} />
                  </TableCell>
                  <TableCell className="text-right">{num(r.good_bottles)}</TableCell>
                  <TableCell className="text-right">{num(damaged)}</TableCell>
                  <TableCell className="text-right">
                    {r.usage_qty == null ? "—" : num(r.usage_qty)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Pieces value={r.expected_remaining} perBag={pb} />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.qc_good == null ? "—" : num(r.qc_good)}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(r.stocked)}
                    {r.pending_stock > 0 && (
                      <div className="text-[11px] text-muted-foreground">
                        +{num(r.pending_stock)} pending
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${
                      r.status === "completed" && (r.variance ?? 0) !== 0 ? "text-destructive" : ""
                    }`}
                  >
                    {r.variance == null || r.status !== "completed" ? "—" : num(r.variance)}
                    {r.open_exceptions > 0 && (
                      <div className="text-[11px] text-destructive">
                        {r.open_exceptions} open exception
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" title="View" onClick={() => setView(r)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      {r.status === "draft" && owns(r) && canRecord && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Edit"
                          onClick={() => setEdit({ id: r.id })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {r.status === "draft" && owns(r) && canSubmit && (
                        <Button
                          size="sm"
                          className="gap-1"
                          disabled={submit.isPending}
                          onClick={() => submit.mutate(r.id)}
                        >
                          <Send className="h-3.5 w-3.5" /> Submit
                        </Button>
                      )}
                      {r.status === "awaiting_stocking" && owns(r) && canSubmit && (
                        <>
                          <Button size="sm" className="gap-1" onClick={() => setSendFor(r)}>
                            <PackageCheck className="h-3.5 w-3.5" /> Stock
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Report shortfall"
                            onClick={() => setAct({ kind: "shortfall", row: r })}
                          >
                            <TriangleAlert className="h-4 w-4 text-warning" />
                          </Button>
                        </>
                      )}
                      {isManager &&
                        ["awaiting_inspection", "awaiting_stocking", "completed"].includes(
                          r.status,
                        ) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Reverse"
                            onClick={() => setAct({ kind: "reverse", row: r })}
                          >
                            <Undo2 className="h-4 w-4" />
                          </Button>
                        )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {(rows.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={13} className="py-8 text-center text-muted-foreground">
                  {rows.isLoading ? "Loading…" : "No shift records in this period."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      {edit && (
        <ShiftDialog factoryId={factoryId} recordId={edit.id} onClose={() => setEdit(null)} />
      )}
      {view && (
        <ShiftDetail row={view} perBag={perBag(view.material)} onClose={() => setView(null)} />
      )}
      {sendFor && (
        <SendStockingDialog
          row={sendFor}
          pending={send.isPending}
          onClose={() => setSendFor(null)}
          onSend={(counted, note) =>
            send.mutate({ id: sendFor.id, counted, note }, { onSuccess: () => setSendFor(null) })
          }
        />
      )}
      <ReasonDialog
        open={!!act}
        onOpenChange={(o) => !o && setAct(null)}
        title={
          act?.kind === "shortfall"
            ? `Report a shortfall on ${act.row.reference}`
            : `Reverse ${act?.row.reference}`
        }
        description={
          act?.kind === "shortfall"
            ? "Use this when the remaining QC-approved bottles will not be stocked. The difference becomes an exception for the production manager — it is never written off silently."
            : "The shift's usage goes back into the operator's balance and its store issues are freed. Allowed only while none of its bottles are with the Warehouse."
        }
        label={act?.kind === "shortfall" ? "What happened" : "Reason"}
        destructive={act?.kind === "reverse"}
        confirmLabel={act?.kind === "shortfall" ? "Report shortfall" : "Reverse shift"}
        pending={shortfall.isPending || reverse.isPending}
        onConfirm={(reason) => {
          if (!act) return;
          const done = { onSuccess: () => setAct(null) };
          if (act.kind === "shortfall") shortfall.mutate({ id: act.row.id, note: reason }, done);
          else reverse.mutate({ id: act.row.id, reason }, done);
        }}
      />
    </Card>
  );
}

// ------------------------------------------------------------ record a shift

function ShiftDialog({
  factoryId,
  recordId,
  onClose,
}: {
  factoryId: string;
  recordId: string | null;
  onClose: () => void;
}) {
  const { can } = usePermissions();
  const isManager = can("preform-production", "reverse");
  const canSubmit = can("preform-production", "submit");
  const me = useMyUserId();
  const materials = usePreformMaterials(factoryId);
  const operators = usePreformOperators(factoryId);
  const existing = useShiftRecord(recordId);
  const suggested = suggestedEntry();

  const [operatorId, setOperatorId] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [date, setDate] = useState(suggested.date);
  const [shift, setShift] = useState<Shift>(suggested.shift);
  const [machine, setMachine] = useState("");
  const [good, setGood] = useState<number | null>(null);
  const [dp, setDp] = useState<number | null>(null);
  const [dbl, setDbl] = useState<number | null>(null);
  const [ol, setOl] = useState<number | null>(null);
  const [olReason, setOlReason] = useState("");
  const [notes, setNotes] = useState("");

  // Load an existing draft once.
  useEffect(() => {
    const r = existing.data;
    if (!r) return;
    setOperatorId(r.operator_id);
    setMaterialId(r.material_id);
    setDate(r.production_date);
    setShift(r.shift);
    setMachine(r.machine ?? "");
    setGood(Number(r.good_bottles));
    setDp(Number(r.damaged_preforms));
    setDbl(Number(r.damaged_bottles));
    setOl(Number(r.other_losses));
    setOlReason(r.other_loss_reason ?? "");
    setNotes(r.notes ?? "");
  }, [existing.data]);
  useEffect(() => {
    if (!recordId && !operatorId && me.data) setOperatorId(me.data);
  }, [me.data, recordId, operatorId]);
  useEffect(() => {
    if (!materialId && materials.data?.length) {
      setMaterialId((materials.data.find((m) => m.output_product_id) ?? materials.data[0]).id);
    }
  }, [materials.data, materialId]);

  const m = materials.data?.find((x) => x.id === materialId);
  const summary = useDaySummary(operatorId, materialId, date);
  const available = summary.data?.held_now ?? 0;
  const usage = (good ?? 0) + (dp ?? 0) + (dbl ?? 0) + (ol ?? 0);
  const remaining = available - usage;

  const save = usePfAction(
    async (andSubmit: boolean) => {
      const r = await rpc<{ id: string }>("save_preform_shift", {
        payload: {
          id: recordId,
          operator_id: operatorId,
          material_id: materialId,
          production_date: date,
          shift,
          machine,
          good_bottles: good ?? 0,
          damaged_preforms: dp ?? 0,
          damaged_bottles: dbl ?? 0,
          other_losses: ol ?? 0,
          other_loss_reason: olReason,
          notes,
        },
      });
      if (!andSubmit) return null;
      return rpc<SubmitResult>("submit_preform_shift", { p_id: r.id });
    },
    (submitted) => (submitted ? submittedMessage(submitted as SubmitResult) : "Draft saved"),
  );

  const operatorList = isManager
    ? (operators.data ?? [])
    : (operators.data ?? []).filter((o) => o.id === me.data);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{recordId ? "Edit shift record" : "Record a shift"}</DialogTitle>
          <DialogDescription>
            Enter what came off the blower. The system works out usage and what should be left — no
            notebook sums.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          {isManager && (
            <div className="space-y-1.5">
              <Label>Operator</Label>
              <Select value={operatorId} onValueChange={setOperatorId} disabled={!!recordId}>
                <SelectTrigger>
                  <SelectValue placeholder="Operator" />
                </SelectTrigger>
                <SelectContent>
                  {operatorList.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Preform</Label>
            <Select value={materialId} onValueChange={setMaterialId}>
              <SelectTrigger>
                <SelectValue placeholder="Preform" />
              </SelectTrigger>
              <SelectContent>
                {(materials.data ?? []).map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {m && !m.output_product_id && (
              <p className="text-[11px] text-destructive">
                No bottle product set up — ask a manager (Setup).
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Production date</Label>
            <Input
              type="date"
              max={localDay()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Shift</Label>
            <Select value={shift} onValueChange={(v) => setShift(v as Shift)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Day</SelectItem>
                <SelectItem value="night">Night</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Machine (optional)</Label>
            <Input
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              placeholder="e.g. Blower 1"
            />
          </div>
        </div>

        <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Good bottles</Label>
            <CountInput value={good} onChange={setGood} placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <Label>Damaged preforms</Label>
            <CountInput value={dp} onChange={setDp} placeholder="0" />
            <p className="text-[11px] text-muted-foreground">Before blowing</p>
          </div>
          <div className="space-y-1.5">
            <Label>Damaged bottles</Label>
            <CountInput value={dbl} onChange={setDbl} placeholder="0" />
            <p className="text-[11px] text-muted-foreground">During blowing</p>
          </div>
          <div className="space-y-1.5">
            <Label>Other losses</Label>
            <CountInput value={ol} onChange={setOl} placeholder="0" />
          </div>
          {(ol ?? 0) > 0 && (
            <div className="space-y-1.5 sm:col-span-4">
              <Label>What were the other losses?</Label>
              <Input value={olReason} onChange={(e) => setOlReason(e.target.value)} />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/40 p-3 text-sm sm:grid-cols-4">
          <Calc
            label="Available now"
            value={<Pieces value={available} perBag={m?.pieces_per_bag} />}
          />
          <Calc
            label="Of which received, not yet used"
            value={<Pieces value={summary.data?.received_unused ?? 0} perBag={m?.pieces_per_bag} />}
          />
          <Calc label="Usage (good + damage)" value={num(usage)} />
          <Calc
            label="Expected remaining"
            value={<Pieces value={remaining} perBag={m?.pieces_per_bag} />}
            tone={remaining < 0 ? "text-destructive" : ""}
          />
          {remaining < 0 && (
            <p className="col-span-2 text-xs text-destructive sm:col-span-4">
              Short by {num(-remaining)} pieces: the operator does not hold enough preforms. Check
              the counts, or make sure the store issue has been accepted. Submitting is blocked.
            </p>
          )}
          {(summary.data?.pending_issues ?? 0) > 0 && (
            <p className="col-span-2 text-xs text-warning sm:col-span-4">
              {num(summary.data?.pending_pieces ?? 0)} pieces issued by the store are waiting to be
              accepted (Store issues tab) and are not counted yet.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Notes (optional)</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="secondary"
            disabled={save.isPending || !operatorId || !materialId}
            onClick={() => save.mutate(false, { onSuccess: onClose })}
          >
            Save draft
          </Button>
          {canSubmit && (
            <Button
              disabled={save.isPending || !operatorId || !materialId || usage <= 0 || remaining < 0}
              onClick={() => save.mutate(true, { onSuccess: onClose })}
            >
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save &amp; submit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Calc({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

// -------------------------------------------------------- send for stocking

function SendStockingDialog({
  row,
  pending,
  onClose,
  onSend,
}: {
  row: ShiftRow;
  pending: boolean;
  onClose: () => void;
  onSend: (counted: number, note: string) => void;
}) {
  const remaining = (row.qc_good ?? 0) - row.stocked - row.pending_stock - row.exception_qty;
  const [counted, setCounted] = useState<number | null>(remaining > 0 ? remaining : null);
  const [note, setNote] = useState("");
  const over = (counted ?? 0) > remaining;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send good bottles to the Warehouse</DialogTitle>
          <DialogDescription>
            {row.reference} · {SHIFT_LABEL[row.shift]} shift {fmtDate(row.production_date)}. Count
            the bottles you are handing over; the Warehouse counts again before stock goes up.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Calc label="QC approved" value={num(row.qc_good ?? 0)} />
          <Calc label="Already stocked / sent" value={num(row.stocked + row.pending_stock)} />
          <Calc label="Left to stock" value={num(remaining)} />
        </div>
        <div className="space-y-1.5">
          <Label>Good bottles counted</Label>
          <CountInput value={counted} onChange={setCounted} />
          {over && (
            <p className="text-xs text-destructive">
              More than QC approved. Bottles beyond what QC approved cannot be stocked — ask QC to
              re-inspect.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Note (optional)</Label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. pallets 1–12"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={pending || !counted || over}
            onClick={() => counted && onSend(counted, note)}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send {counted ? num(counted) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------- detail view

function ShiftDetail({
  row,
  perBag,
  onClose,
}: {
  row: ShiftRow;
  perBag: number | null | undefined;
  onClose: () => void;
}) {
  const record = useShiftRecord(row.id);
  const detail = useQuery({
    queryKey: ["pf", "record-detail", row.id],
    queryFn: async () => {
      const [qc, st, ex, is] = await Promise.all([
        db
          .from("preform_qc_inspections")
          .select("*")
          .eq("shift_record_id", row.id)
          .order("inspected_at"),
        db.from("preform_stockings").select("*").eq("shift_record_id", row.id).order("sent_at"),
        db.from("preform_exceptions").select("*").eq("shift_record_id", row.id).order("raised_at"),
        db
          .from("preform_issues")
          .select("reference,pieces,issue_date")
          .eq("shift_record_id", row.id),
      ]);
      for (const r of [qc, st, ex, is]) if (r.error) throw r.error;
      return {
        qc: (qc.data ?? []) as Record<string, string | number | null>[],
        stockings: (st.data ?? []) as Record<string, string | number | null>[],
        exceptions: (ex.data ?? []) as Record<string, string | number | null>[],
        issues: (is.data ?? []) as { reference: string; pieces: number; issue_date: string }[],
      };
    },
  });
  const names = useUserNames([
    ...(detail.data?.qc ?? []).map((q) => q.inspector_id as string),
    ...(detail.data?.stockings ?? []).flatMap((s) => [
      s.sent_by as string,
      s.received_by as string,
    ]),
  ]);
  const lines = useMemo(
    () =>
      [
        ["Opening stock", row.opening_qty],
        ["Store issues received", row.issued_qty],
        ["Total available", row.available_qty],
        ["Good bottles produced", row.good_bottles],
        ["Damaged preforms (before blowing)", row.damaged_preforms],
        ["Damaged bottles (during blowing)", row.damaged_bottles],
        ["Other losses", row.other_losses],
        ["Total usage", row.usage_qty],
        ["Expected remaining preforms", row.expected_remaining],
        ["QC approved good", row.qc_good],
        ["QC rejected", row.qc_rejected],
        ["Stocked (Warehouse accepted)", row.stocked],
        ["Variance (QC good − stocked)", row.status === "completed" ? row.variance : null],
      ] as [string, number | null][],
    [row],
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {row.reference} <StatusBadge status={row.status} />
          </DialogTitle>
          <DialogDescription>
            {row.operator} · {row.material} · {SHIFT_LABEL[row.shift]} shift{" "}
            {fmtDate(row.production_date)}
            {row.machine ? ` · ${row.machine}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <Table>
            <TableBody>
              {lines.map(([label, v]) => (
                <TableRow key={label}>
                  <TableCell className="py-1.5 text-sm">{label}</TableCell>
                  <TableCell className="py-1.5 text-right font-medium">
                    <Pieces
                      value={v}
                      perBag={
                        label.includes("preform") ||
                        label.includes("available") ||
                        label.includes("Opening") ||
                        label.includes("issues")
                          ? perBag
                          : null
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="space-y-3 text-sm">
            {record.data?.other_loss_reason && (
              <p>
                <span className="text-muted-foreground">Other losses: </span>
                {record.data.other_loss_reason}
              </p>
            )}
            {record.data?.notes && (
              <p>
                <span className="text-muted-foreground">Notes: </span>
                {record.data.notes}
              </p>
            )}
            <div>
              <div className="font-medium">Store issues used</div>
              {(detail.data?.issues ?? []).map((i) => (
                <div key={i.reference} className="text-xs">
                  <span className="font-mono">{i.reference}</span> · {num(Number(i.pieces))} pcs ·{" "}
                  {fmtDate(i.issue_date)}
                </div>
              ))}
              {(detail.data?.issues ?? []).length === 0 && (
                <div className="text-xs text-muted-foreground">None (used opening stock only)</div>
              )}
            </div>
            <div>
              <div className="font-medium">QC</div>
              {(detail.data?.qc ?? []).map((q) => (
                <div key={q.id as string} className="text-xs">
                  {q.decision === "approved"
                    ? `Approved: ${num(Number(q.good_qty))} good, ${num(Number(q.rejected_qty))} rejected`
                    : "Returned to operator"}
                  {q.reason ? ` — ${q.reason}` : ""}
                  {q.notes ? ` (${q.notes})` : ""}
                  <span className="text-muted-foreground">
                    {" "}
                    · {names.data?.[q.inspector_id as string] ?? ""}{" "}
                    {fmtDateTime(q.inspected_at as string)}
                  </span>
                </div>
              ))}
              {(detail.data?.qc ?? []).length === 0 && (
                <div className="text-xs text-muted-foreground">Not inspected yet</div>
              )}
            </div>
            <div>
              <div className="font-medium">Stockings</div>
              {(detail.data?.stockings ?? []).map((s) => (
                <div key={s.id as string} className="text-xs">
                  <span className="font-mono">{s.reference}</span> · sent{" "}
                  {num(Number(s.counted_qty))}
                  {s.received_qty != null
                    ? ` · received ${num(Number(s.received_qty))}`
                    : ""} · <StatusBadge status={s.status as string} />
                </div>
              ))}
              {(detail.data?.stockings ?? []).length === 0 && (
                <div className="text-xs text-muted-foreground">None yet</div>
              )}
            </div>
            {(detail.data?.exceptions ?? []).length > 0 && (
              <div>
                <div className="font-medium">Exceptions</div>
                {(detail.data?.exceptions ?? []).map((e) => (
                  <div key={e.id as string} className="text-xs">
                    <span className="font-mono">{e.reference}</span> ·{" "}
                    {num(Number(e.difference_qty))} · <StatusBadge status={e.status as string} />
                    {e.resolution_note ? ` — ${e.resolution_note}` : e.note ? ` — ${e.note}` : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
