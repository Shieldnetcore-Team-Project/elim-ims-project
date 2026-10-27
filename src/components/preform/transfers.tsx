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
import { ArrowRightLeft, Ban, Check, Loader2, Undo2, X } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { SHIFT_LABEL, localDay, suggestedEntry } from "@/lib/production-shift";
import {
  db,
  rpc,
  useDepartmentStock,
  useMyUserId,
  usePfAction,
  useRejections,
  useTransfers,
  useUserNames,
  type Rejection,
  type Shift,
  type Transfer,
} from "./api";
import { CountInput, ReasonDialog, StatusBadge, fmtDate, fmtDateTime } from "./shared";

// Departments QC sends good bottles to. PM (the filling / packing
// line) is the usual one; others can be typed.
const DEPARTMENTS = ["PM"];

export function TransfersTab({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  // Whoever stocks good bottles in (confirm -- QC) also sends them to
  // production (20261022090000_qc_stocks_good_bottles.sql).
  const canDispatch = can("preform-production", "post") || can("preform-production", "confirm");
  const canReceive = can("preform-production", "submit");
  const canCancel = can("preform-production", "cancel") || canDispatch;
  const canReverse = can("preform-production", "reverse");
  const me = useMyUserId();
  const transfers = useTransfers(factoryId);
  const deptStock = useDepartmentStock(factoryId);
  const names = useUserNames((transfers.data ?? []).flatMap((t) => [t.sent_by, t.received_by]));
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [receive, setReceive] = useState<Transfer | null>(null);
  const [reject, setReject] = useState<Transfer | null>(null);
  const [act, setAct] = useState<{ kind: "cancel" | "reverse"; t: Transfer } | null>(null);
  const rejected = useRejectedByTransfer(factoryId);

  const cancel = usePfAction(
    (a: { id: string; reason: string }) =>
      rpc("cancel_bottle_transfer", { p_id: a.id, p_reason: a.reason }),
    "Transfer cancelled — bottles back in good-bottle stock",
  );
  const reverse = usePfAction(
    (a: { id: string; reason: string }) =>
      rpc("reverse_bottle_transfer", { p_id: a.id, p_reason: a.reason }),
    "Transfer reversed — bottles back in good-bottle stock",
  );

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Send to production (PM)</CardTitle>
            <p className="text-sm text-muted-foreground">
              Good-bottle stock goes down when bottles are dispatched; the department's stock goes
              up by what it confirms receiving. A short receipt becomes an exception — the
              dispatched quantity is never changed.
            </p>
          </div>
          {canDispatch && (
            <Button className="gap-2" onClick={() => setDispatchOpen(true)}>
              <ArrowRightLeft className="h-4 w-4" /> Send to production
            </Button>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Dispatched</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">PM rejected</TableHead>
                <TableHead>Dispatched by</TableHead>
                <TableHead>Received by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(transfers.data ?? []).map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">
                    {t.reference}
                    {(t.production_reference || t.shift) && (
                      <div className="font-sans text-[11px] text-muted-foreground">
                        {[t.production_reference, t.shift && SHIFT_LABEL[t.shift]]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{t.product?.name}</TableCell>
                  <TableCell>{t.to_department}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {t.quantity_requested == null ? "—" : num(t.quantity_requested)}
                  </TableCell>
                  <TableCell className="text-right font-medium">{num(t.quantity_sent)}</TableCell>
                  <TableCell
                    className={`text-right ${
                      t.quantity_received != null && t.quantity_received < t.quantity_sent
                        ? "text-destructive"
                        : ""
                    }`}
                  >
                    {t.quantity_received == null ? "—" : num(t.quantity_received)}
                  </TableCell>
                  <TableCell className="text-right text-destructive">
                    {rejected.get(t.id) ? num(rejected.get(t.id)!) : ""}
                  </TableCell>
                  <TableCell className="text-xs">
                    {names.data?.[t.sent_by ?? ""] ?? ""}
                    <div className="text-muted-foreground">{fmtDateTime(t.sent_at)}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {names.data?.[t.received_by ?? ""] ?? "—"}
                    <div className="text-muted-foreground">{fmtDateTime(t.received_at)}</div>
                    {(t.receive_note || t.reversal_reason) && (
                      <div className="text-muted-foreground">
                        {t.reversal_reason ?? t.receive_note}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {t.status === "dispatched" && canReceive && t.sent_by !== me.data && (
                        <Button size="sm" className="gap-1" onClick={() => setReceive(t)}>
                          <Check className="h-3.5 w-3.5" /> Receive
                        </Button>
                      )}
                      {t.status === "dispatched" && canCancel && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAct({ kind: "cancel", t })}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {["received", "discrepancy"].includes(t.status) &&
                        canReceive &&
                        t.sent_by !== me.data &&
                        (t.quantity_received ?? 0) > (rejected.get(t.id) ?? 0) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1"
                            title="Record bottles PM found defective"
                            onClick={() => setReject(t)}
                          >
                            <Ban className="h-3.5 w-3.5" /> Reject
                          </Button>
                        )}
                      {["received", "discrepancy"].includes(t.status) && canReverse && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Reverse"
                          onClick={() => setAct({ kind: "reverse", t })}
                        >
                          <Undo2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(transfers.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                    No transfers yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Held by departments</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Last change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(deptStock.data ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.department}</TableCell>
                  <TableCell>{d.product?.name}</TableCell>
                  <TableCell className="text-right font-medium">{num(d.quantity)}</TableCell>
                  <TableCell className="text-xs">{fmtDateTime(d.updated_at)}</TableCell>
                </TableRow>
              ))}
              {(deptStock.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    No department has received bottles yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <RejectionsCard factoryId={factoryId} />

      {dispatchOpen && (
        <DispatchDialog factoryId={factoryId} onClose={() => setDispatchOpen(false)} />
      )}
      {receive && <ReceiveDialog t={receive} onClose={() => setReceive(null)} />}
      {reject && (
        <RejectDialog
          t={reject}
          alreadyRejected={rejected.get(reject.id) ?? 0}
          onClose={() => setReject(null)}
        />
      )}
      <ReasonDialog
        open={!!act}
        onOpenChange={(o) => !o && setAct(null)}
        title={act?.kind === "cancel" ? `Cancel ${act.t.reference}` : `Reverse ${act?.t.reference}`}
        description={
          act?.kind === "reverse"
            ? "The department gives back what it received and all dispatched bottles return to good-bottle stock. Refused if the department no longer holds them."
            : "The bottles return to good-bottle stock."
        }
        destructive
        confirmLabel={act?.kind === "cancel" ? "Cancel transfer" : "Reverse"}
        pending={cancel.isPending || reverse.isPending}
        onConfirm={(reason) => {
          if (!act) return;
          const done = { onSuccess: () => setAct(null) };
          if (act.kind === "cancel") cancel.mutate({ id: act.t.id, reason }, done);
          else reverse.mutate({ id: act.t.id, reason }, done);
        }}
      />
    </div>
  );
}

function DispatchDialog({ factoryId, onClose }: { factoryId: string; onClose: () => void }) {
  // The bottle products blowing stocks into: semi-finished products, plus
  // whatever product a preform makes (set on first blowing, any type) or a
  // stocking went into -- otherwise freshly blown bottles were missing here.
  // In-stock bottles first.
  const products = useQuery({
    queryKey: ["pf", "bottle-products", factoryId],
    queryFn: async () => {
      const [stocked, outputs] = await Promise.all([
        db.from("preform_stockings").select("product_id").eq("factory_id", factoryId),
        db
          .from("raw_materials")
          .select("output_product_id")
          .eq("factory_id", factoryId)
          .not("output_product_id", "is", null),
      ]);
      if (stocked.error) throw stocked.error;
      if (outputs.error) throw outputs.error;
      const ids = [
        ...new Set([
          ...((stocked.data ?? []) as { product_id: string }[]).map((r) => r.product_id),
          ...((outputs.data ?? []) as { output_product_id: string }[]).map(
            (r) => r.output_product_id,
          ),
        ]),
      ];
      let q = db
        .from("products")
        .select("id,name,current_stock")
        .eq("factory_id", factoryId)
        .eq("active", true);
      q = ids.length
        ? q.or(`product_type.eq.semi_finished,id.in.(${ids.join(",")})`)
        : q.eq("product_type", "semi_finished");
      const { data, error } = await q.order("name");
      if (error) throw error;
      return ((data ?? []) as { id: string; name: string; current_stock: number }[])
        .map((p) => ({ ...p, current_stock: Number(p.current_stock) }))
        .sort((a, b) => Number(b.current_stock > 0) - Number(a.current_stock > 0));
    },
  });
  const [productId, setProductId] = useState("");
  const [dept, setDept] = useState(DEPARTMENTS[0]);
  const [requested, setRequested] = useState<number | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [shift, setShift] = useState<Shift>(suggestedEntry().shift);
  const [prodRef, setProdRef] = useState("");
  const [notes, setNotes] = useState("");
  const [clientRef] = useState(() => crypto.randomUUID());
  const p = useMemo(
    () => products.data?.find((x) => x.id === productId),
    [products.data, productId],
  );
  // One bottle in stock (the usual case after a blowing): pick it.
  useEffect(() => {
    const inStock = (products.data ?? []).filter((x) => x.current_stock > 0);
    if (!productId && inStock.length === 1) setProductId(inStock[0].id);
  }, [products.data, productId]);
  const over = !!p && (qty ?? 0) > p.current_stock;
  const overRequest = requested != null && (qty ?? 0) > requested;

  const dispatch = usePfAction(
    () =>
      rpc<{ reference: string; duplicate?: boolean }>("dispatch_bottle_transfer", {
        payload: {
          client_ref: clientRef,
          product_id: productId,
          quantity: qty,
          quantity_requested: requested,
          shift,
          production_reference: prodRef,
          to_department: dept,
          notes,
        },
      }),
    (r) => {
      const x = r as { reference: string; duplicate?: boolean };
      return x.duplicate ? `${x.reference} was already dispatched` : `${x.reference} dispatched`;
    },
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send bottles to production</DialogTitle>
          <DialogDescription>
            Good-bottle stock goes down now; the department confirms receipt.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Product</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a product" />
              </SelectTrigger>
              <SelectContent>
                {(products.data ?? []).map((x) => (
                  <SelectItem key={x.id} value={x.id} disabled={x.current_stock <= 0}>
                    {x.name} — {num(x.current_stock)} in stock
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>To department</Label>
            <Input list="pf-departments" value={dept} onChange={(e) => setDept(e.target.value)} />
            <datalist id="pf-departments">
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Requested by PM (optional)</Label>
              <CountInput value={requested} onChange={setRequested} />
            </div>
            <div className="space-y-1.5">
              <Label>Quantity issued</Label>
              <CountInput value={qty} onChange={setQty} />
            </div>
          </div>
          {over && <p className="text-xs text-destructive">More than is in stock.</p>}
          {overRequest && <p className="text-xs text-destructive">More than PM requested.</p>}
          <div className="grid grid-cols-2 gap-3">
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
              <Label>Production reference (optional)</Label>
              <Input
                value={prodRef}
                placeholder="Batch / request no."
                onChange={(e) => setProdRef(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={
              dispatch.isPending || !productId || !dept.trim() || !qty || over || overRequest
            }
            onClick={() => dispatch.mutate(undefined, { onSuccess: onClose })}
          >
            {dispatch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Dispatch {qty ? num(qty) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Posted PM-stage rejections per transfer.
export function useRejectedByTransfer(factoryId: string | undefined) {
  const rejections = useRejections(factoryId);
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rejections.data ?? [])
      if (r.status === "posted") m.set(r.transfer_id, (m.get(r.transfer_id) ?? 0) + r.quantity);
    return m;
  }, [rejections.data]);
}

// Bottles PM found defective after receiving them. Kept apart from the
// blowing-stage damage on the blowing records: they leave PM's stock only
// (record_bottle_rejection, 20261025090000). A manager can reverse one.
export function RejectionsCard({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canReverse = can("preform-production", "reverse");
  const rejections = useRejections(factoryId);
  const names = useUserNames(
    (rejections.data ?? []).flatMap((r) => [r.recorded_by, r.reversed_by]),
  );
  const [undo, setUndo] = useState<Rejection | null>(null);
  const reverse = usePfAction(
    (a: { id: string; reason: string }) =>
      rpc("reverse_bottle_rejection", { p_id: a.id, p_reason: a.reason }),
    "Rejection reversed — bottles back in PM's stock",
  );
  if (!rejections.data?.length) return null;
  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>PM-stage rejections</CardTitle>
        <p className="text-sm text-muted-foreground">
          Bottles PM found defective after receiving them. They come out of PM's stock and are not
          counted as blowing damage.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>PM receipt</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Rejected</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Production ref.</TableHead>
              <TableHead>Recorded by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rejections.data.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {fmtDate(r.production_date)}
                  {r.shift ? ` · ${SHIFT_LABEL[r.shift]}` : ""}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.transfer?.reference}</TableCell>
                <TableCell>{r.product?.name}</TableCell>
                <TableCell className="text-right font-medium text-destructive">
                  {num(r.quantity)}
                </TableCell>
                <TableCell className="max-w-56 text-xs">
                  {r.reason}
                  {r.reversal_reason && (
                    <div className="text-muted-foreground">Reversed: {r.reversal_reason}</div>
                  )}
                </TableCell>
                <TableCell className="text-xs">{r.production_reference ?? "—"}</TableCell>
                <TableCell className="text-xs">
                  {names.data?.[r.recorded_by ?? ""] ?? ""}
                  <div className="text-muted-foreground">{fmtDateTime(r.recorded_at)}</div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-right">
                  {r.status === "posted" && canReverse && (
                    <Button size="icon" variant="ghost" title="Reverse" onClick={() => setUndo(r)}>
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <ReasonDialog
        open={!!undo}
        onOpenChange={(o) => !o && setUndo(null)}
        title={`Reverse ${undo?.reference ?? ""}`}
        description="The bottles return to PM's stock. The rejection stays on record as reversed."
        destructive
        confirmLabel="Reverse"
        pending={reverse.isPending}
        onConfirm={(reason) =>
          undo && reverse.mutate({ id: undo.id, reason }, { onSuccess: () => setUndo(null) })
        }
      />
    </Card>
  );
}

export function RejectDialog({
  t,
  alreadyRejected,
  onClose,
}: {
  t: Transfer;
  alreadyRejected: number;
  onClose: () => void;
}) {
  const max = (t.quantity_received ?? 0) - alreadyRejected;
  const [qty, setQty] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [prodRef, setProdRef] = useState(t.production_reference ?? "");
  const [date, setDate] = useState(localDay());
  const [shift, setShift] = useState<Shift>(suggestedEntry().shift);
  const [clientRef] = useState(() => crypto.randomUUID());
  const over = (qty ?? 0) > max;
  const save = usePfAction(
    () =>
      rpc<{ reference: string; duplicate?: boolean }>("record_bottle_rejection", {
        payload: {
          client_ref: clientRef,
          transfer_id: t.id,
          quantity: qty,
          reason,
          production_reference: prodRef,
          production_date: date,
          shift,
        },
      }),
    (r) => {
      const x = r as { reference: string; duplicate?: boolean };
      return x.duplicate
        ? `${x.reference} was already recorded`
        : `${x.reference}: ${num(qty ?? 0)} bottles rejected at PM`;
    },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject bottles from {t.reference}</DialogTitle>
          <DialogDescription>
            {t.product?.name}: PM received {num(t.quantity_received ?? 0)}
            {alreadyRejected ? `, ${num(alreadyRejected)} already rejected` : ""}. Rejected bottles
            leave PM's stock; they are recorded as PM-stage rejection, not blowing damage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Defective bottles</Label>
            <CountInput value={qty} onChange={setQty} />
            {over && <p className="text-xs text-destructive">At most {num(max)}.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea
              rows={2}
              value={reason}
              placeholder="e.g. thin neck, leaking on the filler"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                max={localDay()}
                onChange={(e) => e.target.value && setDate(e.target.value)}
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
          </div>
          <div className="space-y-1.5">
            <Label>Production batch / reference (optional)</Label>
            <Input value={prodRef} onChange={(e) => setProdRef(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="destructive"
            disabled={save.isPending || !qty || over || !reason.trim()}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject {qty ? num(qty) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReceiveDialog({ t, onClose }: { t: Transfer; onClose: () => void }) {
  const [received, setReceived] = useState<number | null>(t.quantity_sent);
  const [note, setNote] = useState("");
  const short = received != null && received < t.quantity_sent;
  const over = received != null && received > t.quantity_sent;
  const receive = usePfAction(
    () =>
      rpc("receive_bottle_transfer", { p_id: t.id, p_received: received, p_note: note || null }),
    short ? "Received — the shortage is now an exception" : "Received",
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Receive {t.reference}</DialogTitle>
          <DialogDescription>
            {t.product?.name}: {num(t.quantity_sent)} dispatched to {t.to_department}. Enter what
            arrived.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Quantity received</Label>
          <CountInput value={received} onChange={setReceived} />
          {short && (
            <p className="text-xs text-destructive">
              {num(t.quantity_sent - (received ?? 0))} short — this becomes an exception.
            </p>
          )}
          {over && <p className="text-xs text-destructive">More than was dispatched — tell QC.</p>}
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
            disabled={receive.isPending || received == null || over || (short && !note.trim())}
            onClick={() => receive.mutate(undefined, { onSuccess: onClose })}
          >
            {receive.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm {received != null ? num(received) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
