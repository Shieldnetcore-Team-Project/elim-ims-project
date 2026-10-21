import { useState } from "react";
import { Loader2, PackageCheck, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { CountInput, ReasonDialog, fmtDateTime } from "@/components/preform/shared";
import { rpc, useUserNames } from "@/components/preform/api";
import { usePermissions } from "@/lib/permissions";
import { addDays, localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import {
  KIND_NAME,
  STATUS_LABEL,
  useQcJugAction,
  useQcJugBatches,
  useQcJugLive,
  type JugBatch,
  type JugKind,
} from "./jug-api";

// The two ends of the Old & New Jug hand-over (QC's part is jug-register.tsx):
//   WarehouseJugsToQc   Warehouse → Dispenser & Jug: send jugs to QC
//   PmJugsFromQc        Production: good jugs QC posted, confirmed on arrival

const statusVariant = (s: JugBatch["status"]) =>
  s === "received" ? "default" : s === "cancelled" ? "outline" : "secondary";

export function WarehouseJugsToQc({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canSend =
    can("finished-goods", "create") ||
    can("finished-goods", "submit") ||
    can("distribution", "create");
  useQcJugLive();
  const today = localDay();
  const batches = useQcJugBatches(factoryId, addDays(today, -30), today);
  const names = useUserNames((batches.data ?? []).map((b) => b.sent_by));
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState<JugBatch | null>(null);
  const cancel = useQcJugAction(
    (a: { id: string; reason: string }) =>
      rpc("cancel_jugs_to_qc", { p_id: a.id, p_reason: a.reason }),
    "Send cancelled",
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">Old &amp; New Jugs sent to QC</CardTitle>
          <p className="text-xs text-muted-foreground">
            QC counts and accepts them, records the damaged ones and posts the good ones to the
            Production Manager. Last 30 days and anything still open.
          </p>
        </div>
        {canSend && (
          <Button className="gap-2" onClick={() => setSending(true)}>
            <Send className="h-4 w-4" /> Send jugs to QC
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Accepted</TableHead>
              <TableHead className="text-right">Good</TableHead>
              <TableHead className="text-right">Damaged</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(batches.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  {batches.isLoading ? "Loading…" : "No jugs sent to QC recently."}
                </TableCell>
              </TableRow>
            )}
            {(batches.data ?? []).map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.reference}</TableCell>
                <TableCell>{KIND_NAME[b.jug_kind]}</TableCell>
                <TableCell className="text-right">{num(b.quantity_sent)}</TableCell>
                <TableCell className="text-right">
                  {b.quantity_accepted == null ? "—" : num(b.quantity_accepted)}
                </TableCell>
                <TableCell className="text-right">
                  {b.quantity_good == null ? "—" : num(b.quantity_good)}
                </TableCell>
                <TableCell className="text-right">
                  {b.quantity_damaged == null ? "—" : num(b.quantity_damaged)}
                </TableCell>
                <TableCell className="text-xs">
                  {fmtDateTime(b.sent_at)}
                  <div className="text-muted-foreground">{names.data?.[b.sent_by] ?? ""}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(b.status)}>{STATUS_LABEL[b.status]}</Badge>
                  {(b.accept_note || b.cancel_reason) && (
                    <div className="text-[11px] text-muted-foreground">
                      {b.accept_note ?? b.cancel_reason}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {b.status === "sent" && canSend && (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(b)}>
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {sending && <SendDialog factoryId={factoryId} onClose={() => setSending(false)} />}
      <ReasonDialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={`Cancel ${cancelling?.reference ?? ""}`}
        description="Only before QC has accepted it."
        destructive
        confirmLabel="Cancel send"
        pending={cancel.isPending}
        onConfirm={(reason) =>
          cancelling &&
          cancel.mutate({ id: cancelling.id, reason }, { onSuccess: () => setCancelling(null) })
        }
      />
    </Card>
  );
}

function SendDialog({ factoryId, onClose }: { factoryId: string; onClose: () => void }) {
  const [kind, setKind] = useState<JugKind>("new");
  const [qty, setQty] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  // One key per dialog: a double click sends once.
  const [clientRef] = useState(() => crypto.randomUUID());
  const send = useQcJugAction(
    () =>
      rpc<{ reference: string }>("send_jugs_to_qc", {
        payload: {
          client_ref: clientRef,
          factory_id: factoryId,
          jug_kind: kind,
          quantity: qty,
          notes,
        },
      }),
    (r) =>
      `${(r as { reference: string }).reference}: ${num(qty ?? 0)} ${KIND_NAME[kind]}(s) sent to QC`,
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send jugs to QC</DialogTitle>
          <DialogDescription>
            QC counts what arrives and accepts it, then verifies the jugs.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as JugKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">New Jug</SelectItem>
                  <SelectItem value="old">Old Jug</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Quantity</Label>
              <CountInput value={qty} onChange={setQty} placeholder="0" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!qty || send.isPending}
            onClick={() => send.mutate(undefined, { onSuccess: onClose })}
          >
            {send.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send to QC
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PmJugsFromQc({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canReceive = can("production", "submit") || can("production", "create");
  useQcJugLive();
  const today = localDay();
  const batches = useQcJugBatches(factoryId, addDays(today, -7), today);
  const rows = (batches.data ?? []).filter(
    (b) => (b.status === "verified" || b.status === "received") && (b.quantity_good ?? 0) > 0,
  );
  const pending = rows.filter((b) => b.status === "verified");
  const names = useUserNames(rows.flatMap((b) => [b.verified_by, b.received_by]));
  const receive = useQcJugAction(
    (id: string) => rpc<{ reference: string; good: number }>("receive_qc_jugs", { p_id: id }),
    (r) => {
      const x = r as { reference: string; good: number };
      return `${x.reference}: ${num(Number(x.good))} good jugs received from QC`;
    },
  );
  if (!rows.length && !batches.isLoading) return null;

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackageCheck className="h-4 w-4" /> Good jugs from QC
          {pending.length > 0 && <Badge variant="secondary">{pending.length} to confirm</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Old &amp; New Jugs QC verified as good. Confirm when they reach Production.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Good jugs</TableHead>
              <TableHead>Verified by QC</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.reference}</TableCell>
                <TableCell>{KIND_NAME[b.jug_kind]}</TableCell>
                <TableCell className="text-right font-semibold">{num(b.quantity_good)}</TableCell>
                <TableCell className="text-xs">
                  {b.verified_at ? fmtDateTime(b.verified_at) : "—"}
                  <div className="text-muted-foreground">
                    {names.data?.[b.verified_by ?? ""] ?? ""}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(b.status)}>{STATUS_LABEL[b.status]}</Badge>
                  {b.received_at && (
                    <div className="text-[11px] text-muted-foreground">
                      {fmtDateTime(b.received_at)} · {names.data?.[b.received_by ?? ""] ?? ""}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {b.status === "verified" && canReceive && (
                    <Button
                      size="sm"
                      disabled={receive.isPending}
                      onClick={() => receive.mutate(b.id)}
                    >
                      Confirm received
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
