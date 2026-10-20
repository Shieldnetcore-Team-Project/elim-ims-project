import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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
import { ClipboardCheck, Loader2 } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { SHIFT_LABEL, addDays, localDay } from "@/lib/production-shift";
import { rpc, useMyUserId, usePfAction, useShiftReport, type ShiftRow } from "./api";
import { CountInput, StatusBadge, fmtDate, fmtDateTime } from "./shared";

const DISPOSITIONS = [
  "Scrapped",
  "Sent for regrind / recycling",
  "Held for review",
  "Returned to supplier",
];

export function QcTab({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canInspect = can("preform-production", "approve") || can("preform-production", "reject");
  const me = useMyUserId();
  const waiting = useShiftReport(factoryId, {
    from: "2000-01-01",
    to: localDay(),
    status: "awaiting_inspection",
  });
  const recent = useShiftReport(factoryId, { from: addDays(localDay(), -13), to: localDay() });
  const [target, setTarget] = useState<ShiftRow | null>(null);
  const inspected = (recent.data ?? []).filter((r) => r.qc_good != null);

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Waiting for QC</CardTitle>
          <p className="text-sm text-muted-foreground">
            QC classifies every good bottle the operator reported as good or rejected. Only
            QC-approved good bottles can be stocked.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>Date / shift</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead>Preform</TableHead>
                <TableHead className="text-right">Good reported</TableHead>
                <TableHead className="text-right">Damaged (operator)</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(waiting.data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {fmtDate(r.production_date)} · {SHIFT_LABEL[r.shift]}
                  </TableCell>
                  <TableCell>{r.operator}</TableCell>
                  <TableCell>{r.material}</TableCell>
                  <TableCell className="text-right font-medium">{num(r.good_bottles)}</TableCell>
                  <TableCell className="text-right">
                    {num(r.damaged_preforms + r.damaged_bottles + r.other_losses)}
                  </TableCell>
                  <TableCell className="text-xs">{fmtDateTime(r.submitted_at)}</TableCell>
                  <TableCell className="text-right">
                    {canInspect && r.operator_id !== me.data && (
                      <Button size="sm" className="gap-1" onClick={() => setTarget(r)}>
                        <ClipboardCheck className="h-3.5 w-3.5" /> Inspect
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(waiting.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    Nothing waiting for QC.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Inspected in the last two weeks</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>Date / shift</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead className="text-right">Reported good</TableHead>
                <TableHead className="text-right">QC good</TableHead>
                <TableHead className="text-right">QC rejected</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inspected.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {fmtDate(r.production_date)} · {SHIFT_LABEL[r.shift]}
                  </TableCell>
                  <TableCell>{r.operator}</TableCell>
                  <TableCell className="text-right">{num(r.good_bottles)}</TableCell>
                  <TableCell className="text-right font-medium">{num(r.qc_good ?? 0)}</TableCell>
                  <TableCell className="text-right">{num(r.qc_rejected ?? 0)}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                </TableRow>
              ))}
              {inspected.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    No inspections in the last two weeks.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {target && <InspectDialog row={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

function InspectDialog({ row, onClose }: { row: ShiftRow; onClose: () => void }) {
  const { can } = usePermissions();
  const [good, setGood] = useState<number | null>(row.good_bottles);
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState(DISPOSITIONS[0]);
  const [notes, setNotes] = useState("");
  const rejected = row.good_bottles - (good ?? 0);
  const invalid = good == null || good > row.good_bottles;

  const inspect = usePfAction(
    (decision: "approved" | "returned") =>
      rpc("inspect_preform_shift", {
        p_id: row.id,
        p_decision: decision,
        p_good: decision === "approved" ? good : 0,
        p_rejected: decision === "approved" ? rejected : 0,
        p_reason: decision === "approved" ? reason || null : null,
        p_disposition: decision === "approved" && rejected > 0 ? disposition : null,
        p_notes: notes || null,
      }),
    "QC recorded",
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Inspect {row.reference}</DialogTitle>
          <DialogDescription>
            {row.operator} · {row.material} · {SHIFT_LABEL[row.shift]} shift{" "}
            {fmtDate(row.production_date)}. The operator reported {num(row.good_bottles)} good
            bottles (damage they recorded is already out and is not counted again here).
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Good (approved)</Label>
            <CountInput value={good} onChange={setGood} />
          </div>
          <div className="space-y-1.5">
            <Label>Rejected by QC</Label>
            <Input value={invalid ? "—" : num(rejected)} disabled />
          </div>
          {good != null && good > row.good_bottles && (
            <p className="col-span-2 text-xs text-destructive">
              QC cannot approve more than the {num(row.good_bottles)} the operator reported.
            </p>
          )}
          {rejected > 0 && !invalid && (
            <>
              <div className="col-span-2 space-y-1.5">
                <Label>Reason for rejection</Label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. thin walls, cloudy"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>What happens to the rejected bottles</Label>
                <Select value={disposition} onValueChange={setDisposition}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DISPOSITIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="col-span-2 space-y-1.5">
            <Label>Notes (required to return to the operator)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {can("preform-production", "reject") && (
            <Button
              variant="destructive"
              disabled={inspect.isPending || !notes.trim()}
              onClick={() => inspect.mutate("returned", { onSuccess: onClose })}
            >
              Return to operator
            </Button>
          )}
          {can("preform-production", "approve") && (
            <Button
              disabled={inspect.isPending || invalid || (rejected > 0 && !reason.trim())}
              onClick={() => inspect.mutate("approved", { onSuccess: onClose })}
            >
              {inspect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Approve {invalid ? "" : num(good ?? 0)} good
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
