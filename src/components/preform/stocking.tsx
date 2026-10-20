import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Check, Loader2, Undo2, X } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { SHIFT_LABEL } from "@/lib/production-shift";
import { rpc, useMyUserId, usePfAction, useStockings, useUserNames, type Stocking } from "./api";
import { CountInput, ReasonDialog, StatusBadge, fmtDate, fmtDateTime } from "./shared";

export function StockingTab({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canAccept = can("preform-production", "confirm");
  const canRefuse = canAccept && can("preform-production", "reject");
  const canWithdraw = can("preform-production", "submit");
  const canReverse = can("preform-production", "reverse");
  const me = useMyUserId();
  const all = useStockings(factoryId);
  const names = useUserNames(
    (all.data ?? []).flatMap((s) => [s.sent_by, s.received_by, s.record?.operator_id]),
  );
  const pending = (all.data ?? []).filter((s) => s.status === "sent");
  const history = (all.data ?? []).filter((s) => s.status !== "sent");
  const [accept, setAccept] = useState<Stocking | null>(null);
  const [act, setAct] = useState<{ kind: "refuse" | "withdraw" | "reverse"; s: Stocking } | null>(
    null,
  );

  const refuse = usePfAction(
    (a: { id: string; note: string }) =>
      rpc("reject_preform_stocking", { p_id: a.id, p_note: a.note }),
    "Stocking refused — the bottles are again waiting to be stocked",
  );
  const withdraw = usePfAction(
    (a: { id: string; note: string }) =>
      rpc("cancel_preform_stocking", { p_id: a.id, p_reason: a.note }),
    "Stocking withdrawn",
  );
  const reverse = usePfAction(
    (a: { id: string; note: string }) =>
      rpc("reverse_preform_stocking", { p_id: a.id, p_reason: a.note }),
    "Stocking reversed — bottles taken back out of Warehouse stock",
  );

  const recordCell = (s: Stocking) => (
    <TableCell>
      <span className="font-mono text-xs">{s.record?.reference}</span>
      {s.record && (
        <div className="text-xs text-muted-foreground">
          {fmtDate(s.record.production_date)} · {SHIFT_LABEL[s.record.shift]} ·{" "}
          {names.data?.[s.record.operator_id] ?? ""}
        </div>
      )}
    </TableCell>
  );

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Good bottles waiting for the Warehouse</CardTitle>
          <p className="text-sm text-muted-foreground">
            Count what arrived and accept it. Warehouse stock rises by what you count; if it is less
            than was sent, the difference becomes an exception for the production manager.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stocking</TableHead>
                <TableHead>Shift record</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">QC good left</TableHead>
                <TableHead className="text-right">Sent (operator count)</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.reference}</TableCell>
                  {recordCell(s)}
                  <TableCell>{s.product?.name}</TableCell>
                  <TableCell className="text-right">{num(s.expected_qty)}</TableCell>
                  <TableCell className="text-right font-medium">{num(s.counted_qty)}</TableCell>
                  <TableCell className="text-xs">
                    {names.data?.[s.sent_by ?? ""] ?? ""}
                    <div className="text-muted-foreground">{fmtDateTime(s.sent_at)}</div>
                    {s.send_note && <div className="text-muted-foreground">{s.send_note}</div>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {canAccept && s.sent_by !== me.data && (
                        <Button size="sm" className="gap-1" onClick={() => setAccept(s)}>
                          <Check className="h-3.5 w-3.5" /> Count &amp; accept
                        </Button>
                      )}
                      {canRefuse && s.sent_by !== me.data && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAct({ kind: "refuse", s })}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canWithdraw && s.sent_by === me.data && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAct({ kind: "withdraw", s })}
                        >
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {pending.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Nothing waiting.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Stocking history</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stocking</TableHead>
                <TableHead>Shift record</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((s) => {
                const diff = s.accepted_qty == null ? null : s.counted_qty - s.accepted_qty;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.reference}</TableCell>
                    {recordCell(s)}
                    <TableCell>{s.product?.name}</TableCell>
                    <TableCell className="text-right">{num(s.counted_qty)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {s.accepted_qty == null ? "—" : num(s.accepted_qty)}
                    </TableCell>
                    <TableCell className={`text-right ${diff ? "text-destructive" : ""}`}>
                      {diff == null ? "—" : diff === 0 ? "0" : `−${num(diff)}`}
                    </TableCell>
                    <TableCell className="text-xs">
                      {names.data?.[s.received_by ?? ""] ?? "—"}
                      <div className="text-muted-foreground">{fmtDateTime(s.received_at)}</div>
                      {(s.receive_note || s.reversal_reason) && (
                        <div className="text-muted-foreground">
                          {s.reversal_reason ?? s.receive_note}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {s.status === "accepted" && canReverse && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Reverse"
                          onClick={() => setAct({ kind: "reverse", s })}
                        >
                          <Undo2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {history.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                    No stockings yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {accept && <AcceptDialog s={accept} onClose={() => setAccept(null)} />}
      <ReasonDialog
        open={!!act}
        onOpenChange={(o) => !o && setAct(null)}
        title={
          act?.kind === "refuse"
            ? `Refuse ${act.s.reference}`
            : act?.kind === "withdraw"
              ? `Withdraw ${act?.s.reference}`
              : `Reverse ${act?.s.reference}`
        }
        description={
          act?.kind === "reverse"
            ? "The accepted bottles leave Warehouse stock and the shift record goes back to awaiting stocking. Refused if the bottles are no longer in the Warehouse."
            : "Nothing moves; the bottles are again waiting to be stocked on the shift record."
        }
        required={act?.kind !== "withdraw"}
        destructive={act?.kind !== "withdraw"}
        confirmLabel={
          act?.kind === "refuse" ? "Refuse" : act?.kind === "withdraw" ? "Withdraw" : "Reverse"
        }
        pending={refuse.isPending || withdraw.isPending || reverse.isPending}
        onConfirm={(note) => {
          if (!act) return;
          const done = { onSuccess: () => setAct(null) };
          if (act.kind === "refuse") refuse.mutate({ id: act.s.id, note }, done);
          else if (act.kind === "withdraw") withdraw.mutate({ id: act.s.id, note }, done);
          else reverse.mutate({ id: act.s.id, note }, done);
        }}
      />
    </div>
  );
}

function AcceptDialog({ s, onClose }: { s: Stocking; onClose: () => void }) {
  const [received, setReceived] = useState<number | null>(s.counted_qty);
  const [note, setNote] = useState("");
  const short = received != null && received < s.counted_qty;
  const over = received != null && received > s.counted_qty;
  const accept = usePfAction(
    () =>
      rpc("accept_preform_stocking", { p_id: s.id, p_received: received, p_note: note || null }),
    short ? "Accepted — the shortage is now an exception" : "Accepted into Warehouse stock",
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Count &amp; accept {s.reference}</DialogTitle>
          <DialogDescription>
            {s.product?.name}: the operator sent {num(s.counted_qty)}. Enter what you counted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Good bottles counted at the Warehouse</Label>
          <CountInput value={received} onChange={setReceived} />
          {short && (
            <p className="text-xs text-destructive">
              {num(s.counted_qty - (received ?? 0))} fewer than sent — this becomes an exception.
            </p>
          )}
          {over && (
            <p className="text-xs text-destructive">
              More than was sent. Accept {num(s.counted_qty)} and ask the operator to send the extra
              as a new stocking.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Note {short ? "(required)" : "(optional)"}</Label>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={accept.isPending || received == null || over || (short && !note.trim())}
            onClick={() => accept.mutate(undefined, { onSuccess: onClose })}
          >
            {accept.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Accept {received != null ? num(received) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
