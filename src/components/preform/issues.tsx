import { useMemo, useState, type ReactNode } from "react";
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
import { Check, Eye, Loader2, PackagePlus, Search, Undo2, X } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { formatPieces, toPieces } from "@/lib/preform-units";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { useFactoryId } from "@/lib/use-factory";
import {
  preformDetail,
  rpc,
  useIssues,
  useMyUserId,
  usePfAction,
  usePreformMaterials,
  usePreformOperators,
  usePreformOverview,
  useUserNames,
  type Issue,
  type PreformMaterial,
  type PreformOverview,
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
  // Brand, grammage, supplier and where each preform stands now.
  const overview = usePreformOverview(factoryId);
  const names = useUserNames((issues.data ?? []).flatMap((i) => [i.operator_id, i.issued_by]));
  const [issueOpen, setIssueOpen] = useState(false);
  const [viewing, setViewing] = useState<Issue | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [act, setAct] = useState<{ kind: "reject" | "cancel" | "reverse"; issue: Issue } | null>(
    null,
  );

  const matById = useMemo(
    () => Object.fromEntries((materials.data ?? []).map((m) => [m.id, m])),
    [materials.data],
  );
  const infoById = useMemo(
    () => Object.fromEntries((overview.data ?? []).map((o) => [o.material_id, o])),
    [overview.data],
  );
  const nameOf = (id: string) => matById[id]?.name ?? infoById[id]?.material ?? "—";
  const rows = (issues.data ?? []).filter((i) => {
    const term = q.trim().toLowerCase();
    return (
      (status === "all" || i.status === status) &&
      (!term ||
        [
          i.reference,
          nameOf(i.material_id),
          preformDetail(infoById[i.material_id]),
          names.data?.[i.operator_id] ?? "",
          i.notes ?? "",
        ].some((s) => s.toLowerCase().includes(term)))
    );
  });

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
            {receiveOnly
              ? "Preforms issued to Quality Control"
              : "Store issues to the blowing line"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {receiveOnly
              ? "Every preform the Store issues (Store → Preform Inventory / Issue Stock), with its full details. Accept each one before it counts as available for blowing."
              : "The store issues bags of preforms to an operator. The operator accepts them before they count as available."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-9 w-56 pl-8"
              placeholder="Search reference, preform, brand…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="issued">Waiting to accept</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="reversed">Reversed</SelectItem>
            </SelectContent>
          </Select>
          {canIssue && (
            <Button className="gap-2" onClick={() => setIssueOpen(true)}>
              <PackagePlus className="h-4 w-4" /> Issue preforms
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Preform</TableHead>
              <TableHead>{receiveOnly ? "Issued to" : "Operator"}</TableHead>
              <TableHead className="text-right">Bags</TableHead>
              <TableHead className="text-right">Pieces</TableHead>
              <TableHead>Issued by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((i) => {
              const mine = i.operator_id === me.data;
              const detail = preformDetail(infoById[i.material_id]);
              return (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-xs">{i.reference}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDate(i.issue_date)}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{nameOf(i.material_id)}</div>
                    {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
                    {i.notes && (
                      <div className="max-w-56 text-[11px] italic text-muted-foreground">
                        {i.notes}
                      </div>
                    )}
                  </TableCell>
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
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Full details"
                        aria-label="Full details"
                        onClick={() => setViewing(i)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
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
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {(issues.data ?? []).length === 0
                    ? "No preforms issued yet."
                    : "No issues match the search."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      {viewing && (
        <IssueDetailsDialog
          issue={viewing}
          name={nameOf(viewing.material_id)}
          info={infoById[viewing.material_id]}
          names={names.data ?? {}}
          onClose={() => setViewing(null)}
        />
      )}

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

// Everything about one issue: the preform in full, what was issued, who
// issued and received it, and where that preform stands now (Store, QC,
// blown, damaged, good bottles).
function IssueDetailsDialog({
  issue: i,
  name,
  info,
  names,
  onClose,
}: {
  issue: Issue;
  name: string;
  info: PreformOverview | undefined;
  names: Record<string, string>;
  onClose: () => void;
}) {
  const line = (label: string, value: ReactNode) =>
    value === null || value === undefined || value === "" ? null : (
      <>
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="text-right">{value}</dd>
      </>
    );
  const responded =
    i.status === "accepted" ? "Accepted" : i.status === "rejected" ? "Rejected" : "Answered";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {i.reference} — {name}
          </DialogTitle>
          <DialogDescription>
            <StatusBadge status={i.status} />
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Preform</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              {line("Material", name)}
              {line("Brand", info?.brand)}
              {line("Grammage", info?.grammage)}
              {line("Supplier", info?.supplier)}
              {line("Pieces per bag", num(i.pieces_per_bag))}
            </dl>
          </section>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Issued</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              {line("Issue date", fmtDate(i.issue_date))}
              {line("Bags", `${num(i.bags)} × ${num(i.pieces_per_bag)}`)}
              {line("Loose pieces", i.loose_pieces ? num(i.loose_pieces) : null)}
              {line("Total pieces", <span className="font-semibold">{num(i.pieces)}</span>)}
              {line("Issued to", names[i.operator_id] ?? "…")}
              {line("Issued by", `${names[i.issued_by ?? ""] ?? "—"}, ${fmtDateTime(i.issued_at)}`)}
              {line(responded, i.responded_at ? fmtDateTime(i.responded_at) : null)}
              {line("Note", i.notes)}
              {line("Response", i.response_note)}
              {line("Reversal reason", i.reversal_reason)}
            </dl>
          </section>
          {info && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                This preform now (all issues)
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
                {line("In the Store", formatPieces(info.in_store, info.pieces_per_bag))}
                {line("Issued from the Store", num(info.issued))}
                {line("Waiting to be accepted", num(info.waiting))}
                {line("Received by QC", num(info.received))}
                {line("Blown", num(info.blown))}
                {line("Damages", <span className="text-destructive">{num(info.damages)}</span>)}
                {line("Good bottles (Blown − Damages)", num(info.good))}
                {line("QC holds, not yet blown", num(info.qc_holds))}
              </dl>
            </section>
          )}
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
  const { data: factoryId } = useFactoryId();
  const overview = usePreformOverview(factoryId);
  const info = overview.data?.find((o) => o.material_id === materialId);
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
              {m && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 rounded-md bg-muted/40 p-2 text-xs">
                  {info?.brand && (
                    <>
                      <dt className="text-muted-foreground">Brand</dt>
                      <dd>{info.brand}</dd>
                    </>
                  )}
                  {info?.grammage && (
                    <>
                      <dt className="text-muted-foreground">Grammage</dt>
                      <dd>{info.grammage}</dd>
                    </>
                  )}
                  {info?.supplier && (
                    <>
                      <dt className="text-muted-foreground">Supplier</dt>
                      <dd>{info.supplier}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Pieces per bag</dt>
                  <dd>{m.pieces_per_bag ? num(m.pieces_per_bag) : "—"}</dd>
                  <dt className="text-muted-foreground">In the Store</dt>
                  <dd>
                    {formatPieces(m.current_stock, m.pieces_per_bag)} ({num(m.current_stock)}{" "}
                    pieces)
                  </dd>
                  {info && info.waiting > 0 && (
                    <>
                      <dt className="text-muted-foreground">Issued, not yet accepted</dt>
                      <dd>{num(info.waiting)} pieces</dd>
                    </>
                  )}
                </dl>
              )}
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
