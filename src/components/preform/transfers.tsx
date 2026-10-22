import { useMemo, useState } from "react";
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
import { ArrowRightLeft, Check, Loader2, Undo2, X } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import {
  db,
  rpc,
  useDepartmentStock,
  useMyUserId,
  usePfAction,
  useTransfers,
  useUserNames,
  type Transfer,
} from "./api";
import { CountInput, ReasonDialog, StatusBadge, fmtDateTime } from "./shared";

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
  const [act, setAct] = useState<{ kind: "cancel" | "reverse"; t: Transfer } | null>(null);

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
                <TableHead className="text-right">Dispatched</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead>Dispatched by</TableHead>
                <TableHead>Received by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(transfers.data ?? []).map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.reference}</TableCell>
                  <TableCell>{t.product?.name}</TableCell>
                  <TableCell>{t.to_department}</TableCell>
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
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
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

      {dispatchOpen && (
        <DispatchDialog factoryId={factoryId} onClose={() => setDispatchOpen(false)} />
      )}
      {receive && <ReceiveDialog t={receive} onClose={() => setReceive(null)} />}
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
  // Semi-finished products (the empty bottles) in stock.
  const products = useQuery({
    queryKey: ["pf", "semi-products", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("products")
        .select("id,name,current_stock")
        .eq("factory_id", factoryId)
        .eq("product_type", "semi_finished")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return ((data ?? []) as { id: string; name: string; current_stock: number }[]).map((p) => ({
        ...p,
        current_stock: Number(p.current_stock),
      }));
    },
  });
  const [productId, setProductId] = useState("");
  const [dept, setDept] = useState(DEPARTMENTS[0]);
  const [qty, setQty] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [clientRef] = useState(() => crypto.randomUUID());
  const p = useMemo(
    () => products.data?.find((x) => x.id === productId),
    [products.data, productId],
  );
  const over = !!p && (qty ?? 0) > p.current_stock;

  const dispatch = usePfAction(
    () =>
      rpc<{ reference: string }>("dispatch_bottle_transfer", {
        payload: {
          client_ref: clientRef,
          product_id: productId,
          quantity: qty,
          to_department: dept,
          notes,
        },
      }),
    (r) => `${(r as { reference: string }).reference} dispatched`,
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
                  <SelectItem key={x.id} value={x.id}>
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
          <div className="space-y-1.5">
            <Label>Quantity</Label>
            <CountInput value={qty} onChange={setQty} />
            {over && <p className="text-xs text-destructive">More than is in stock.</p>}
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
            disabled={dispatch.isPending || !productId || !dept.trim() || !qty || over}
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

function ReceiveDialog({ t, onClose }: { t: Transfer; onClose: () => void }) {
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
