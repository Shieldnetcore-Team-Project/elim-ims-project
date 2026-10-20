import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { CountInput, fmtDateTime } from "@/components/preform/shared";
import { rpc, useUserNames } from "@/components/preform/api";
import { formatDay } from "@/lib/jug-accountability";
import { money, num } from "@/lib/format";
import {
  ROLE_LABEL,
  SOURCE_LABEL,
  dayEnd,
  dayStart,
  useJugAction,
  useJugMovements,
  useJugReturns,
  useProductLinks,
  type JugRole,
  type Named,
  type ReportRow,
} from "./api";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ----------------------------------------------------------- record return
// What the marketer says they brought back. Nothing moves until the
// Warehouse counts it (Returns tab -> Confirm count).
export function RecordReturnDialog({
  marketers,
  types,
  initialRepId,
  initialTypeId,
  onClose,
}: {
  marketers: Named[];
  types: { id: string; name: string }[];
  initialRepId?: string;
  initialTypeId?: string;
  onClose: () => void;
}) {
  const [repId, setRepId] = useState(initialRepId ?? "");
  const [typeId, setTypeId] = useState(initialTypeId ?? types[0]?.id ?? "");
  const [qty, setQty] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  // One key per dialog: a double click records one return.
  const [clientRef] = useState(() => crypto.randomUUID());
  const save = useJugAction(
    () =>
      rpc<{ reference: string }>("record_jug_return", {
        payload: {
          client_ref: clientRef,
          sales_rep_id: repId,
          container_type_id: typeId,
          quantity: qty,
          notes,
        },
      }),
    (r) =>
      `${(r as { reference: string }).reference} recorded — the Warehouse counts and confirms it`,
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record empty-jug return</DialogTitle>
          <DialogDescription>
            What the marketer says they brought back. It counts as &quot;Returned&quot; now and
            reduces Outstanding only when the Warehouse confirms its count.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Marketer / outlet">
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {marketers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.code ? `${m.code} · ` : ""}
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Jug type">
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Empty jugs returned">
            <CountInput value={qty} onChange={setQty} placeholder="0" />
          </Field>
          <Field label="Notes (optional)">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!repId || !typeId || !qty || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Record return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------- adjustment
// Approved corrections on the existing container ledger
// (record_container_movement): an opening balance for jugs a marketer held
// before tracking began, or jugs written off as lost. Both need a reason.
export function AdjustDialog({
  factoryId,
  marketers,
  types,
  canWriteOff,
  onClose,
}: {
  factoryId: string;
  marketers: Named[];
  types: { id: string; name: string }[];
  canWriteOff: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"issue" | "lost">("issue");
  const [repId, setRepId] = useState("");
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [qty, setQty] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [reference, setReference] = useState("");
  const save = useJugAction(
    () =>
      rpc("record_container_movement", {
        payload: {
          factory_id: factoryId,
          container_type_id: typeId,
          kind,
          holder_type: "sales_rep",
          holder_id: repId,
          quantity: qty,
          notes,
          reference,
        },
      }),
    kind === "issue" ? "Opening balance recorded" : "Jugs written off",
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Jug adjustment</DialogTitle>
          <DialogDescription>
            Corrections are new ledger entries — nothing is edited or deleted.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field
            label="Type"
            hint={
              kind === "issue"
                ? "Jugs the marketer already held before tracking began (their opening balance). Shown as Loaded on today's report."
                : "Jugs the marketer cannot account for. They stop being outstanding."
            }
          >
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="issue">Opening balance / jugs issued</SelectItem>
                {canWriteOff && <SelectItem value="lost">Write off as lost</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Marketer / outlet">
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {marketers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.code ? `${m.code} · ` : ""}
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Jug type">
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Jugs">
            <CountInput value={qty} onChange={setQty} placeholder="0" />
          </Field>
          <Field label="Supporting reference">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. count sheet no."
            />
          </Field>
          <Field label="Reason">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={kind === "lost" ? "destructive" : "default"}
            disabled={!repId || !typeId || !qty || notes.trim().length < 5 || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {kind === "issue" ? "Record opening balance" : "Write off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ day detail
// Every transaction behind one row of the report.
export function RowDetailDialog({
  factoryId,
  row,
  productNames,
  onClose,
}: {
  factoryId: string;
  row: ReportRow;
  productNames: Record<string, string>;
  onClose: () => void;
}) {
  const movements = useJugMovements(factoryId, row.report_date, row.report_date, row.sales_rep_id);
  const returns = useJugReturns(factoryId, row.report_date, row.report_date);
  const lines = (movements.data ?? []).filter((m) => m.container_type_id === row.container_type_id);
  const claims = (returns.data ?? []).filter(
    (r) =>
      r.sales_rep_id === row.sales_rep_id &&
      r.container_type_id === row.container_type_id &&
      new Date(r.recorded_at) >= new Date(dayStart(row.report_date)) &&
      new Date(r.recorded_at) <= new Date(dayEnd(row.report_date)),
  );
  const names = useUserNames([
    ...lines.map((l) => l.created_by),
    ...claims.map((c) => c.recorded_by),
  ]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {row.rep_name} · {row.container_name} · {formatDay(row.report_date)}
          </DialogTitle>
          <DialogDescription>
            Opening {num(row.opening)} + Loaded {num(row.loaded)} = {num(row.total)}; − Jug + Water{" "}
            {num(row.jug_water_sold)} − Empties sold {num(row.empties_sold)} = Expected{" "}
            {num(row.expected_empties)}; − Received {num(row.received)} − Written off{" "}
            {num(row.written_off)} = Outstanding {num(row.outstanding)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-sm font-medium">Ledger movements</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Jugs</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-4 text-center text-muted-foreground">
                      {movements.isLoading ? "Loading…" : "No jug movements this day."}
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l) => {
                  const toRep = l.to_type === "sales_rep" && l.to_id === row.sales_rep_id;
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDateTime(l.created_at)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {SOURCE_LABEL[l.source] ?? l.source}
                      </TableCell>
                      <TableCell className="text-xs">
                        {l.product_id ? (productNames[l.product_id] ?? "—") : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{l.reference ?? "—"}</TableCell>
                      <TableCell
                        className={`text-right font-medium ${toRep ? "text-primary" : "text-destructive"}`}
                      >
                        {toRep ? "+" : "−"}
                        {num(l.quantity)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {names.data?.[l.created_by ?? ""] ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {row.refills_sold > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Also {num(row.refills_sold)} refills sold — swaps, so no jug left the marketer.
              </p>
            )}
            {row.empties_value > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Empty jugs sold for {money(row.empties_value)}.
              </p>
            )}
          </div>
          <div>
            <div className="mb-1 text-sm font-medium">Empty-jug returns</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead className="text-right">Returned</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claims.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-4 text-center text-muted-foreground">
                      No returns recorded.
                    </TableCell>
                  </TableRow>
                )}
                {claims.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.reference}</TableCell>
                    <TableCell className="text-xs">
                      {fmtDateTime(c.recorded_at)}
                      <div className="text-muted-foreground">
                        {names.data?.[c.recorded_by] ?? ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{num(c.quantity_claimed)}</TableCell>
                    <TableCell className="text-right">
                      {c.quantity_received == null ? "—" : num(c.quantity_received)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.status === "verified"
                            ? "default"
                            : c.status === "pending"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {c.status === "pending" ? "Awaiting count" : c.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

// ------------------------------------------------------------------ setup
// Jug types and which products carry them, with the role that decides what
// a sale does to the jug. Managers only (distribution approve).
export function JugSetupPanel({
  factoryId,
  types,
}: {
  factoryId: string;
  types: { id: string; name: string; active: boolean }[];
}) {
  const data = useProductLinks(factoryId);
  const [newType, setNewType] = useState("");
  const addType = useJugAction(
    (name: string) =>
      rpc("save_container_type", {
        p_factory: factoryId,
        p_id: null,
        p_name: name,
        p_active: true,
      }),
    "Jug type added",
  );
  const setRole = useJugAction(
    (a: { product: string; type: string; qty: number; role: JugRole | null }) =>
      rpc("set_product_jug_role", {
        p_product: a.product,
        p_container_type: a.type,
        p_quantity: a.qty,
        p_role: a.role,
      }),
    "Saved",
  );
  const linkFor = useMemo(() => {
    const m = new Map<string, { type: string; qty: number; role: JugRole | null }>();
    for (const l of data.data?.links ?? [])
      if (types.some((t) => t.id === l.container_type_id))
        m.set(l.product_id, {
          type: l.container_type_id,
          qty: l.quantity_per_unit,
          role: l.jug_role,
        });
    return m;
  }, [data.data, types]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Jug types</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {types.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
            >
              {t.name}
              {!t.active && <Badge variant="outline">Inactive</Badge>}
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              placeholder="e.g. 19L Dispenser Jug"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
            />
            <Button
              disabled={!newType.trim() || addType.isPending}
              onClick={() => addType.mutate(newType.trim(), { onSuccess: () => setNewType("") })}
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="rounded-2xl lg:col-span-2">
        <CardHeader>
          <CardTitle>Products that carry a jug</CardTitle>
          <p className="text-sm text-muted-foreground">
            Refill: the customer swaps an empty, so the marketer still owes the jug. Jug + Water:
            the customer keeps it. Empty jug: sold as an empty, its price is the Empties Cost.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Jug type</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.data?.products ?? [])
                .filter((p) => p.active)
                .map((p) => {
                  const l = linkFor.get(p.id);
                  return (
                    <TableRow key={p.id}>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>
                        <Select
                          value={l?.type ?? "none"}
                          disabled={setRole.isPending}
                          onValueChange={(v) =>
                            v === "none"
                              ? l &&
                                setRole.mutate({ product: p.id, type: l.type, qty: 0, role: null })
                              : setRole.mutate({
                                  product: p.id,
                                  type: v,
                                  qty: 1,
                                  role: l?.role ?? "refill",
                                })
                          }
                        >
                          <SelectTrigger className="w-44">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No jug</SelectItem>
                            {types.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {l ? (
                          <Select
                            value={l.role ?? "with_water"}
                            disabled={setRole.isPending}
                            onValueChange={(v) =>
                              setRole.mutate({
                                product: p.id,
                                type: l.type,
                                qty: l.qty,
                                role: v as JugRole,
                              })
                            }
                          >
                            <SelectTrigger className="w-72">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(ROLE_LABEL) as JugRole[]).map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ROLE_LABEL[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
