import { useMemo, useState } from "react";
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
import { Check, Loader2, PackagePlus, Undo2, X } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { formatPieces, toPieces } from "@/lib/preform-units";
import { localDay } from "@/lib/production-shift";
import {
  rpc,
  useIssues,
  useMyUserId,
  usePfAction,
  usePreformMaterials,
  usePreformOperators,
  useUserNames,
  type Issue,
  type PreformMaterial,
} from "./api";
import { CountInput, Pieces, ReasonDialog, StatusBadge, fmtDate, fmtDateTime } from "./shared";

// `receiveOnly`: the Quality Control page, where QC accepts what the Store
// issued her -- issuing itself is done from Store → Preform Inventory.
export function IssuesTab({
  factoryId,
  receiveOnly = false,
}: {
  factoryId: string;
  receiveOnly?: boolean;
}) {
  const { can } = usePermissions();
  const canIssue = can("preform-production", "post") && !receiveOnly;
  const canCancel = can("preform-production", "cancel") || canIssue;
  const canReverse = can("preform-production", "reverse");
  const canRespond = can("preform-production", "submit");
  const me = useMyUserId();
  const materials = usePreformMaterials(factoryId);
  const operators = usePreformOperators(factoryId);
  const issues = useIssues(factoryId);
  const names = useUserNames((issues.data ?? []).flatMap((i) => [i.operator_id, i.issued_by]));
  const [issueOpen, setIssueOpen] = useState(false);
  const [act, setAct] = useState<{ kind: "reject" | "cancel" | "reverse"; issue: Issue } | null>(
    null,
  );

  const matById = useMemo(
    () => Object.fromEntries((materials.data ?? []).map((m) => [m.id, m])),
    [materials.data],
  );

  const respond = usePfAction(
    (a: { id: string; accept: boolean; note?: string }) =>
      rpc("respond_preform_issue", { p_id: a.id, p_accept: a.accept, p_note: a.note ?? null }),
    "Issue updated",
  );
  const cancel = usePfAction(
    (a: { id: string; reason: string }) =>
      rpc("cancel_preform_issue", { p_id: a.id, p_reason: a.reason }),
    "Issue cancelled — preforms back in the store",
  );
  const reverse = usePfAction(
    (a: { id: string; reason: string }) =>
      rpc("reverse_preform_issue", { p_id: a.id, p_reason: a.reason }),
    "Issue reversed — preforms back in the store",
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>
            {receiveOnly ? "Preforms issued to you" : "Store issues to the blowing line"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {receiveOnly
              ? "The Store issues preforms from Store → Preform Inventory. Accept them here before they count as available for your shifts."
              : "The store issues bags of preforms to an operator. The operator accepts them before they count as available."}
          </p>
        </div>
        {canIssue && (
          <Button className="gap-2" onClick={() => setIssueOpen(true)}>
            <PackagePlus className="h-4 w-4" /> Issue preforms
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Preform</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead className="text-right">Bags</TableHead>
              <TableHead className="text-right">Pieces</TableHead>
              <TableHead>Issued by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(issues.data ?? []).map((i) => {
              const mine = i.operator_id === me.data;
              return (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-xs">{i.reference}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDate(i.issue_date)}
                  </TableCell>
                  <TableCell>{matById[i.material_id]?.name ?? "—"}</TableCell>
                  <TableCell>{names.data?.[i.operator_id] ?? "…"}</TableCell>
                  <TableCell className="text-right">
                    {i.bags}
                    {i.loose_pieces > 0 && (
                      <span className="text-xs text-muted-foreground"> + {i.loose_pieces} pcs</span>
                    )}
                    <div className="text-[11px] text-muted-foreground">× {i.pieces_per_bag}</div>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <Pieces value={i.pieces} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {names.data?.[i.issued_by ?? ""] ?? "—"}
                    <div className="text-muted-foreground">{fmtDateTime(i.issued_at)}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={i.status} />
                    {(i.response_note || i.reversal_reason) && (
                      <div className="mt-1 max-w-48 text-[11px] text-muted-foreground">
                        {i.reversal_reason ?? i.response_note}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {i.status === "issued" && canRespond && (mine || canReverse) && (
                        <>
                          <Button
                            size="sm"
                            className="gap-1"
                            disabled={respond.isPending}
                            onClick={() => respond.mutate({ id: i.id, accept: true })}
                          >
                            <Check className="h-3.5 w-3.5" /> Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setAct({ kind: "reject", issue: i })}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      {i.status === "issued" && canCancel && !mine && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAct({ kind: "cancel", issue: i })}
                        >
                          Cancel
                        </Button>
                      )}
                      {i.status === "accepted" && !i.shift_record_id && canReverse && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Reverse to store"
                          onClick={() => setAct({ kind: "reverse", issue: i })}
                        >
                          <Undo2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {(issues.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  No preforms issued yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      {issueOpen && (
        <IssueDialog
          materials={materials.data ?? []}
          operators={operators.data ?? []}
          onClose={() => setIssueOpen(false)}
        />
      )}
      <ReasonDialog
        open={!!act}
        onOpenChange={(o) => !o && setAct(null)}
        title={
          act?.kind === "reject"
            ? `Reject ${act.issue.reference}`
            : act?.kind === "cancel"
              ? `Cancel ${act?.issue.reference}`
              : `Reverse ${act?.issue.reference}`
        }
        description={
          act?.kind === "reverse"
            ? "The preforms leave the operator's balance and go back into the store."
            : "The preforms go back into the store."
        }
        destructive
        confirmLabel={
          act?.kind === "reject" ? "Reject" : act?.kind === "cancel" ? "Cancel issue" : "Reverse"
        }
        pending={respond.isPending || cancel.isPending || reverse.isPending}
        onConfirm={(reason) => {
          if (!act) return;
          const done = { onSuccess: () => setAct(null) };
          if (act.kind === "reject")
            respond.mutate({ id: act.issue.id, accept: false, note: reason }, done);
          else if (act.kind === "cancel") cancel.mutate({ id: act.issue.id, reason }, done);
          else reverse.mutate({ id: act.issue.id, reason }, done);
        }}
      />
    </Card>
  );
}

// Also opened from Store → Preform Inventory, with the preform preselected.
export function IssueDialog({
  materials,
  operators,
  initialMaterialId,
  onClose,
}: {
  materials: PreformMaterial[];
  operators: { id: string; full_name: string }[];
  initialMaterialId?: string;
  onClose: () => void;
}) {
  const ready = materials.filter((m) => m.pieces_per_bag);
  const [materialId, setMaterialId] = useState(
    ready.some((m) => m.id === initialMaterialId) ? initialMaterialId! : (ready[0]?.id ?? ""),
  );
  const [operatorId, setOperatorId] = useState(operators.length === 1 ? operators[0].id : "");
  const [bags, setBags] = useState<number | null>(null);
  const [loose, setLoose] = useState<number | null>(null);
  const [date, setDate] = useState(localDay());
  const [notes, setNotes] = useState("");
  // One key per dialog: a double click posts once.
  const [clientRef] = useState(() => crypto.randomUUID());
  const m = materials.find((x) => x.id === materialId);
  const pieces = m?.pieces_per_bag ? toPieces(bags ?? 0, loose ?? 0, m.pieces_per_bag) : 0;
  const tooMany = !!m && pieces > m.current_stock;

  const issue = usePfAction(
    () =>
      rpc<{ reference: string }>("issue_preforms", {
        payload: {
          client_ref: clientRef,
          material_id: materialId,
          operator_id: operatorId,
          bags: bags ?? 0,
          loose_pieces: loose ?? 0,
          issue_date: date,
          notes,
        },
      }),
    (r) => `${(r as { reference: string }).reference} issued`,
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Issue preforms</DialogTitle>
          <DialogDescription>
            Store stock goes down now; the operator's balance goes up when they accept.
          </DialogDescription>
        </DialogHeader>
        {ready.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No preform has pieces-per-bag set up yet. A production manager sets it in Quality
            Control → Good bottles → Setup.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Preform</Label>
              <Select value={materialId} onValueChange={setMaterialId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a preform" />
                </SelectTrigger>
                <SelectContent>
                  {ready.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.name} — {formatPieces(x.current_stock, x.pieces_per_bag)} in store
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Receiving operator</Label>
              <Select value={operatorId} onValueChange={setOperatorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick the operator" />
                </SelectTrigger>
                <SelectContent>
                  {operators.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Bags</Label>
              <CountInput value={bags} onChange={setBags} placeholder="0" />
              {m?.pieces_per_bag && (
                <p className="text-[11px] text-muted-foreground">
                  {m.pieces_per_bag} pieces per bag
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Loose pieces</Label>
              <CountInput value={loose} onChange={setLoose} placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <Label>Issue date</Label>
              <Input
                type="date"
                max={localDay()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col justify-end rounded-xl border p-3">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className={`text-lg font-semibold ${tooMany ? "text-destructive" : ""}`}>
                {pieces.toLocaleString()} pieces
              </div>
              {tooMany && (
                <div className="text-[11px] text-destructive">More than the store holds</div>
              )}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Notes (optional)</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={!materialId || !operatorId || pieces <= 0 || tooMany || issue.isPending}
            onClick={() => issue.mutate(undefined, { onSuccess: onClose })}
          >
            {issue.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Issue {pieces > 0 ? pieces.toLocaleString() : ""} pieces
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
