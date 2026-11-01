import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CountInput, fmtDateTime } from "@/components/preform/shared";
import { rpc, useMyUserId } from "@/components/preform/api";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { useQcJugAction, useQcJugLive } from "./jug-api";

// Quality Control -> Old & New Jugs: empty jugs the Warehouse recorded from
// marketers (and the shop), waiting for QC's count (user, 2026-11-01). QC's
// count is final: it credits the marketer N-per-jug, moves the jugs back to
// the factory and becomes an accepted consignment below, which QC verifies
// and posts to the PM as usual (verify_jug_return, 20261101100000). Whoever
// recorded a return can't count it.

type Pending = {
  id: string;
  reference: string;
  holder: string;
  holder_kind: string;
  jug: string;
  quantity_claimed: number;
  notes: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  recorded_at: string;
};

export function QcJugReturnsToCount({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canCount = can("goods-receiving", "submit");
  const me = useMyUserId().data;
  useQcJugLive();
  const [counting, setCounting] = useState<Pending | null>(null);
  const pending = useQuery({
    queryKey: ["qc-jugs", "pending-returns", factoryId],
    queryFn: () => rpc<Pending[]>("qc_pending_jug_returns", { p_factory: factoryId }),
  });
  const rows = pending.data ?? [];
  if (!pending.isLoading && rows.length === 0) return null;

  return (
    <Card className="rounded-2xl border-amber-500/50">
      <CardHeader>
        <CardTitle className="text-base">Empty jugs returned — to count</CardTitle>
        <p className="text-xs text-muted-foreground">
          The Warehouse recorded these from marketers and the shop. Count what physically arrived:
          your count is final — the marketer is credited for each jug counted, and any missing jug
          stays on their account.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Jug</TableHead>
              <TableHead className="text-right">Recorded</TableHead>
              <TableHead>Recorded by</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                <TableCell>
                  {r.holder}
                  <div className="text-[11px] text-muted-foreground">
                    {r.holder_kind === "outlet" ? "Retail shop" : "Marketer"}
                  </div>
                </TableCell>
                <TableCell>{r.jug}</TableCell>
                <TableCell className="text-right">{num(Number(r.quantity_claimed))}</TableCell>
                <TableCell className="text-xs">
                  {fmtDateTime(r.recorded_at)}
                  <div className="text-muted-foreground">{r.recorded_by_name ?? ""}</div>
                </TableCell>
                <TableCell className="text-right">
                  {canCount && r.recorded_by !== me && (
                    <Button size="sm" onClick={() => setCounting(r)}>
                      Count
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {pending.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      {counting && <CountDialog row={counting} onClose={() => setCounting(null)} />}
    </Card>
  );
}

function CountDialog({ row, onClose }: { row: Pending; onClose: () => void }) {
  const [qty, setQty] = useState<number | null>(Number(row.quantity_claimed));
  const [note, setNote] = useState("");
  const short = qty != null && qty < Number(row.quantity_claimed);
  const save = useQcJugAction(
    () => rpc("verify_jug_return", { p_id: row.id, p_received: qty, p_note: note || null }),
    `${row.reference}: ${num(qty ?? 0)} counted`,
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Count {row.reference}</DialogTitle>
          <DialogDescription>
            {row.holder}: the Warehouse recorded {num(Number(row.quantity_claimed))} {row.jug}.
            Enter what physically arrived.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>Counted</Label>
            <CountInput value={qty} onChange={setQty} placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <Label>{short ? "Why fewer? (required)" : "Note (optional)"}</Label>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {short && (
            <p className="text-xs text-amber-600">
              {num(Number(row.quantity_claimed) - (qty ?? 0))} jug(s) short — they stay on{" "}
              {row.holder}&apos;s account.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={qty == null || (short && !note.trim()) || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm count
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
