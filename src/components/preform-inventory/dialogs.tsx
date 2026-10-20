import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { SupplierPicker } from "@/components/shared/supplier-picker";
import { BagSizeSetup, CostPerBagInput } from "@/components/shared/bag-quantity";
import { CountInput } from "@/components/preform/shared";
import { db, rpc } from "@/components/preform/api";
import { useCurrentUserName } from "@/lib/use-current-user";
import { localDay } from "@/lib/production-shift";
import { money, num } from "@/lib/format";
import { formatPieces } from "@/lib/preform-units";
import { ADJUSTMENT_REASONS } from "@/lib/adjustment-reasons";
import {
  DISPOSITION_LABEL,
  receiptPieces,
  useFactorySuppliers,
  usePinvAction,
  type PreformRow,
} from "./api";

const DEPARTMENTS = ["Preform Blowing", "PM (Filling & Packing)", "Quality Control"];

function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------ register / edit
// A preform specification is the material (size, neck, weight, colour...);
// suppliers are linked to it, not built into it. Two suppliers of the same
// interchangeable preform are one specification with two suppliers.
export function PreformFormDialog({
  factoryId,
  editing,
  onClose,
}: {
  factoryId: string;
  editing: PreformRow | null;
  onClose: () => void;
}) {
  const suppliers = useFactorySuppliers(factoryId);
  const preferred = editing?.suppliers.find((s) => s.preferred);
  const [name, setName] = useState(editing?.name ?? "");
  const [code, setCode] = useState(editing?.material_code ?? "");
  const [spec, setSpec] = useState(editing?.specification ?? "");
  const [supplierId, setSupplierId] = useState(preferred?.id ?? "none");
  const [perBag, setPerBag] = useState<number | null>(editing?.pieces_per_bag ?? null);
  const [perBagReason, setPerBagReason] = useState("");
  const [unit, setUnit] = useState(editing?.unit ?? "Piece");
  const [location, setLocation] = useState(editing?.storage_location ?? "");
  const [department, setDepartment] = useState(editing?.production_department ?? "Preform Blowing");
  const [reorder, setReorder] = useState<number | null>(editing?.reorder_level ?? null);
  const [active, setActive] = useState(editing?.active ?? true);
  const [remarks, setRemarks] = useState(editing?.remarks ?? "");
  const perBagChanged =
    !!editing?.pieces_per_bag && perBag != null && perBag !== editing.pieces_per_bag;

  const save = usePinvAction(
    () =>
      rpc<{ material_code: string }>("save_preform_material", {
        payload: {
          id: editing?.id ?? null,
          factory_id: factoryId,
          name,
          material_code: code || null,
          specification: spec,
          preferred_supplier_id: supplierId === "none" ? null : supplierId,
          pieces_per_bag: perBag,
          pieces_per_bag_reason: perBagReason || null,
          unit,
          storage_location: location,
          production_department: department,
          reorder_level: reorder ?? 0,
          active,
          remarks,
        },
      }),
    (r) =>
      editing
        ? "Preform updated"
        : `Preform registered as ${(r as { material_code: string }).material_code}`,
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "Add preform"}</DialogTitle>
          <DialogDescription>
            One entry per preform specification. Stock is not entered here — it arrives through
            receipts, or an approved opening balance (Counts tab).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Preform name" className="sm:col-span-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PET Preform 75cl 28mm"
            />
          </Field>
          <Field label="Material code" hint={editing ? undefined : "Leave blank to generate PF-…"}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Auto"
            />
          </Field>
          <Field label="Specification" hint="Neck size, weight, colour, machine…">
            <Input
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              placeholder="e.g. 28mm PCO, 18g, clear"
            />
          </Field>
          <Field
            label="Preferred supplier"
            hint="Other suppliers can be linked on the preform's page."
            className="sm:col-span-2"
          >
            <SupplierPicker
              factoryId={factoryId}
              suppliers={suppliers.data ?? []}
              value={supplierId}
              onChange={setSupplierId}
            />
          </Field>
          <Field
            label="Pieces per bag"
            hint={
              perBag
                ? `Stock is kept in pieces; 1 bag = ${num(perBag)} pieces.`
                : "Leave blank if this preform is not delivered in bags."
            }
          >
            <CountInput value={perBag} onChange={setPerBag} placeholder="e.g. 1428" />
          </Field>
          <Field label="Base unit" hint={editing ? "Fixed after registration." : undefined}>
            <Select value={unit} onValueChange={setUnit} disabled={!!editing}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from(new Set(["Piece", unit])).map((u) => (
                  <SelectItem key={u} value={u}>
                    {u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {perBagChanged && (
            <Field
              label="Reason for changing pieces per bag"
              hint="Past receipts and issues keep the bag size they were recorded with."
              className="sm:col-span-2"
            >
              <Input value={perBagReason} onChange={(e) => setPerBagReason(e.target.value)} />
            </Field>
          )}
          <Field label="Storage location">
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Store A, bay 3"
            />
          </Field>
          <Field label="Used by">
            <Input
              list="pinv-departments"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            />
            <datalist id="pinv-departments">
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>
          <Field
            label="Reorder level (pieces)"
            hint={perBag && reorder ? formatPieces(reorder, perBag) : undefined}
          >
            <CountInput value={reorder} onChange={setReorder} placeholder="0" />
          </Field>
          <div className="flex items-center gap-3 pt-6">
            <Switch checked={active} onCheckedChange={setActive} id="pinv-active" />
            <Label htmlFor="pinv-active">{active ? "Active" : "Inactive"}</Label>
          </div>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !name.trim() || save.isPending || (perBagChanged && perBagReason.trim().length < 5)
            }
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Register preform"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ receive
// Records a delivery through the existing goods-receipt workflow
// (submit_goods_receipt): QC / receiving records what came and what was
// rejected; a different person in the Store confirms it, and only then do
// the accepted pieces go into stock.
type OpenOrder = {
  id: string;
  po_number: string;
  material_id: string;
  supplier_id: string | null;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number | null;
};

export function ReceiveDialog({
  factoryId,
  preforms,
  initialMaterialId,
  onClose,
}: {
  factoryId: string;
  preforms: PreformRow[];
  initialMaterialId?: string;
  onClose: () => void;
}) {
  const suppliers = useFactorySuppliers(factoryId);
  const me = useCurrentUserName();
  const usable = preforms.filter((p) => p.active && p.approval_status === "approved");
  const [materialId, setMaterialId] = useState(initialMaterialId ?? usable[0]?.id ?? "");
  const m = preforms.find((p) => p.id === materialId);
  const [savedPerBag, setSavedPerBag] = useState<Record<string, number>>({});
  const preferred = m?.suppliers.find((s) => s.preferred)?.id;
  const [supplierId, setSupplierId] = useState<string>(preferred ?? "none");
  // Bag size is packaging: a supplier may pack this preform in its own size.
  // Otherwise the specification's. The server applies the same rule
  // (receipt_pieces_per_bag) and keeps the size on the receipt.
  const specPerBag = m ? (savedPerBag[m.id] ?? m.pieces_per_bag) : null;
  const supplierPerBag =
    m?.suppliers.find((s) => s.id === supplierId && s.active)?.pieces_per_bag ?? null;
  const perBag = supplierPerBag ?? specPerBag;
  const [orderId, setOrderId] = useState("none");
  const [mode, setMode] = useState<"bags" | "pieces">(perBag ? "bags" : "pieces");
  const [bags, setBags] = useState<number | null>(null);
  const [loose, setLoose] = useState<number | null>(null);
  const [pieces, setPieces] = useState<number | null>(null);
  const [rejected, setRejected] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [disposition, setDisposition] = useState("return_to_supplier");
  const [unitCost, setUnitCost] = useState(0);
  const [invoice, setInvoice] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [batch, setBatch] = useState("");
  const [deliveryDate, setDeliveryDate] = useState(localDay());
  const [location, setLocation] = useState(m?.storage_location ?? "");
  const [inspector, setInspector] = useState("");
  const [notes, setNotes] = useState("");
  // One key per dialog: a double click records one delivery.
  const [clientRef] = useState(() => crypto.randomUUID());

  const orders = useQuery({
    queryKey: ["pinv", "open-orders", factoryId, materialId],
    enabled: !!materialId,
    queryFn: async () => {
      const { data, error } = await db
        .from("purchase_orders")
        .select("id,po_number,material_id,supplier_id,quantity_ordered,quantity_received,unit_cost")
        .eq("factory_id", factoryId)
        .eq("material_id", materialId)
        .in("status", ["issued", "partially_received"])
        .order("issued_at", { ascending: false });
      // Without purchase-order access the list is simply empty.
      if (error) return [] as OpenOrder[];
      return (data ?? []) as OpenOrder[];
    },
  });
  const order = (orders.data ?? []).find((o) => o.id === orderId);
  const outstanding = order
    ? Number(order.quantity_ordered) - Number(order.quantity_received)
    : null;

  const total = receiptPieces(mode, bags, loose, pieces, perBag);
  const accepted = Math.max(total - (rejected ?? 0), 0);
  const inspectorName = inspector || me.data || "";
  const needsBagSize = !!m && !perBag && mode === "bags";

  const pickMaterial = (id: string) => {
    setMaterialId(id);
    const x = preforms.find((p) => p.id === id);
    setSupplierId(x?.suppliers.find((s) => s.preferred)?.id ?? "none");
    setLocation(x?.storage_location ?? "");
    setMode(x?.pieces_per_bag ? "bags" : "pieces");
    setOrderId("none");
    setUnitCost(x?.last_purchase_cost ?? 0);
  };
  const pickOrder = (id: string) => {
    setOrderId(id);
    const o = (orders.data ?? []).find((x) => x.id === id);
    if (o?.supplier_id) setSupplierId(o.supplier_id);
    if (o?.unit_cost != null) setUnitCost(Number(o.unit_cost));
  };

  const problem = !m
    ? "Pick the preform delivered"
    : needsBagSize
      ? "Set the bag size first"
      : total <= 0
        ? "Enter what was delivered"
        : (rejected ?? 0) > total
          ? "Rejected cannot exceed delivered"
          : (rejected ?? 0) > 0 && !rejectReason.trim()
            ? "Give the reason for the rejection"
            : outstanding != null && total > outstanding
              ? `Only ${num(outstanding)} pieces are outstanding on this order`
              : !inspectorName.trim()
                ? "Enter who inspected the delivery"
                : null;

  const submit = usePinvAction(
    () =>
      rpc<{ receipt_number: string }>("submit_goods_receipt", {
        payload: {
          client_ref: clientRef,
          material_id: materialId,
          purchase_order_id: order?.id ?? null,
          supplier_id: supplierId === "none" ? null : supplierId,
          ...(mode === "bags"
            ? { bags: bags ?? 0, loose_pieces: loose ?? 0, pieces_per_bag: perBag }
            : { quantity: pieces ?? 0 }),
          damaged_quantity: rejected ?? 0,
          rejection_reason: rejectReason || null,
          rejected_disposition: (rejected ?? 0) > 0 ? disposition : null,
          unit_cost: unitCost,
          supplier_invoice: invoice,
          delivery_reference: deliveryNote || null,
          batch_number: batch,
          delivery_date: deliveryDate,
          storage_location: location,
          remarks: [`QC inspected by ${inspectorName.trim()}`, notes.trim()]
            .filter(Boolean)
            .join(" — "),
        },
      }),
    (r) =>
      `${(r as { receipt_number: string }).receipt_number} recorded — the Store confirms it into stock`,
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Receive preforms</DialogTitle>
          <DialogDescription>
            Record the delivery and the inspection. Stock rises only by the accepted pieces, when a
            different person in the Store confirms the receipt.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Preform" className="sm:col-span-2">
            <Select value={materialId} onValueChange={pickMaterial}>
              <SelectTrigger>
                <SelectValue placeholder="Pick the preform" />
              </SelectTrigger>
              <SelectContent>
                {usable.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.material_code ? `${p.material_code} · ` : ""}
                    {p.name}
                    {p.pieces_per_bag ? ` (${num(p.pieces_per_bag)}/bag)` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Supplier"
            hint={
              supplierPerBag && supplierPerBag !== specPerBag
                ? `This supplier packs ${num(supplierPerBag)} per bag${specPerBag ? ` (usual: ${num(specPerBag)})` : ""}.`
                : undefined
            }
          >
            <SupplierPicker
              factoryId={factoryId}
              suppliers={suppliers.data ?? []}
              value={supplierId}
              onChange={setSupplierId}
            />
          </Field>
          <Field label="Purchase order">
            <Select value={orderId} onValueChange={pickOrder}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Not linked to a PO —</SelectItem>
                {(orders.data ?? []).map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.po_number} · {num(Number(o.quantity_ordered) - Number(o.quantity_received))}{" "}
                    outstanding
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Supplier invoice no.">
            <Input value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </Field>
          <Field label="Delivery note / waybill">
            <Input value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />
          </Field>

          {m && !perBag && (
            <div className="sm:col-span-2">
              <BagSizeSetup
                materialId={m.id}
                materialName={m.name}
                onSaved={(v) => {
                  setSavedPerBag((s) => ({ ...s, [m.id]: v }));
                  setMode("bags");
                }}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Or record this delivery in pieces below.
              </p>
            </div>
          )}

          <Field label="Delivered in" className="sm:col-span-2">
            <Select value={mode} onValueChange={(v) => setMode(v as "bags" | "pieces")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bags" disabled={!perBag}>
                  Bags {perBag ? `(${num(perBag)} pieces each)` : "(set the bag size first)"}
                </SelectItem>
                <SelectItem value="pieces">Pieces (counted individually)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mode === "bags" ? (
            <>
              <Field label="Full bags received">
                <CountInput value={bags} onChange={setBags} placeholder="0" />
              </Field>
              <Field label="Loose pieces" hint="Pieces delivered outside full bags.">
                <CountInput value={loose} onChange={setLoose} placeholder="0" />
              </Field>
            </>
          ) : (
            <Field label="Pieces received" className="sm:col-span-2">
              <CountInput value={pieces} onChange={setPieces} placeholder="0" />
            </Field>
          )}
          <div className="rounded-xl border bg-muted/30 p-3 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Total delivered</div>
            <div className="text-lg font-semibold">{formatPieces(total, perBag)}</div>
            {mode === "bags" && perBag && (
              <div className="text-[11px] text-muted-foreground">
                {num(bags ?? 0)} × {num(perBag)} + {num(loose ?? 0)} loose
              </div>
            )}
          </div>

          <Field
            label="Rejected at inspection (pieces)"
            hint={perBag && rejected ? formatPieces(rejected, perBag) : undefined}
          >
            <CountInput value={rejected} onChange={setRejected} placeholder="0" />
          </Field>
          <Field label="Rejected stock">
            <Select
              value={disposition}
              onValueChange={setDisposition}
              disabled={!(rejected && rejected > 0)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DISPOSITION_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {!!rejected && rejected > 0 && (
            <Field label="Rejection reason" className="sm:col-span-2">
              <Input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. deformed necks, wrong weight, contamination"
              />
            </Field>
          )}
          <div className="rounded-xl border p-3 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Accepted into stock on confirmation</div>
            <div className="text-lg font-semibold text-primary">
              {formatPieces(accepted, perBag)}
            </div>
            {unitCost > 0 && (
              <div className="text-[11px] text-muted-foreground">
                Value {money(accepted * unitCost)}
              </div>
            )}
          </div>

          <CostPerBagInput
            unitCost={unitCost}
            onChange={setUnitCost}
            perBag={mode === "bags" ? perBag : null}
            unit={m?.unit}
          />
          <Field label="Delivery date">
            <Input
              type="date"
              max={localDay()}
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
            />
          </Field>
          <Field label="Storage location">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label="Batch / lot">
            <Input value={batch} onChange={(e) => setBatch(e.target.value)} />
          </Field>
          <Field label="Inspected by" hint={`Recorded by ${me.data ?? "you"}.`}>
            <Input
              value={inspectorName}
              onChange={(e) => setInspector(e.target.value)}
              placeholder="Inspector's name"
            />
          </Field>
          <Field label="Notes">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter className="items-center gap-2">
          {problem && <span className="mr-auto text-xs text-muted-foreground">{problem}</span>}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!!problem || submit.isPending}
            onClick={() => submit.mutate(undefined, { onSuccess: onClose })}
          >
            {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send to Store for confirmation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ physical count
// The Store enters what it physically counted; the server works out the
// variance against stock and raises a stock adjustment for someone else to
// approve and post. Stock is never typed in directly.
export function CountDialog({
  preforms,
  initialMaterialId,
  onClose,
}: {
  preforms: PreformRow[];
  initialMaterialId?: string;
  onClose: () => void;
}) {
  const [materialId, setMaterialId] = useState(initialMaterialId ?? preforms[0]?.id ?? "");
  const m = preforms.find((p) => p.id === materialId);
  const [kind, setKind] = useState<"count" | "opening_balance">("count");
  const [bags, setBags] = useState<number | null>(null);
  const [loose, setLoose] = useState<number | null>(null);
  const [pieces, setPieces] = useState<number | null>(null);
  const [unitCost, setUnitCost] = useState(0);
  const [reference, setReference] = useState("");
  const [reasonChoice, setReasonChoice] = useState<string>(ADJUSTMENT_REASONS[0]);
  const [reasonText, setReasonText] = useState("");
  // Bags on the shelf may be of different sizes (suppliers pack
  // differently): count each size separately, or count in pieces.
  const bagSizes = useMemo(
    () =>
      [
        ...new Set(
          [m?.pieces_per_bag, ...(m?.suppliers ?? []).map((s) => s.pieces_per_bag)].filter(
            (x): x is number => !!x,
          ),
        ),
      ].sort((a, b) => a - b),
    [m],
  );
  const [countIn, setCountIn] = useState<string>("default");
  const perBag =
    countIn === "pieces"
      ? null
      : countIn === "default"
        ? (m?.pieces_per_bag ?? bagSizes[0] ?? null)
        : Number(countIn);
  const mode = perBag ? "bags" : "pieces";
  const counted = useMemo(
    () =>
      bags == null && loose == null && pieces == null
        ? null
        : receiptPieces(mode, bags, loose, pieces, perBag),
    [bags, loose, pieces, mode, perBag],
  );
  const variance = counted == null || !m ? null : counted - m.current_stock;
  const reason =
    kind === "opening_balance"
      ? reasonText.trim() || "Opening balance from physical count"
      : [reasonChoice === "Other" ? "" : reasonChoice, reasonText.trim()]
          .filter(Boolean)
          .join(" — ");

  const submit = usePinvAction(
    () =>
      rpc<{ request: boolean; reference_number?: string; variance: number }>(
        "request_stock_count",
        {
          payload: {
            material_id: materialId,
            kind,
            ...(mode === "bags"
              ? {
                  counted_bags: bags ?? 0,
                  counted_loose: loose ?? 0,
                  counted_pieces_per_bag: perBag,
                }
              : { counted_quantity: pieces ?? 0 }),
            unit_cost: kind === "opening_balance" ? unitCost : null,
            supporting_reference: reference,
            reason,
          },
        },
      ),
    (r) => {
      const x = r as { request: boolean; reference_number?: string };
      return x.request
        ? `${x.reference_number} raised — awaiting approval`
        : "Count matches the system — recorded, no adjustment needed";
    },
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record a physical count</DialogTitle>
          <DialogDescription>
            Enter what is physically in the store. Any difference becomes an adjustment that another
            authorised person approves and posts.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Preform">
            <Select
              value={materialId}
              onValueChange={(v) => {
                setMaterialId(v);
                setCountIn("default");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick the preform" />
              </SelectTrigger>
              <SelectContent>
                {preforms.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.material_code ? `${p.material_code} · ` : ""}
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Type"
            hint={
              kind === "opening_balance"
                ? "Once per preform, to bring existing stock into the system."
                : undefined
            }
          >
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="count">Physical count (stock take)</SelectItem>
                <SelectItem value="opening_balance">Opening balance</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {bagSizes.length > 0 && (
            <Field
              label="Count in"
              hint="Stock is recorded in pieces; the bag size used is kept on the count."
            >
              <Select
                value={countIn}
                onValueChange={(v) => {
                  setCountIn(v);
                  setBags(null);
                  setLoose(null);
                  setPieces(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {m?.pieces_per_bag && (
                    <SelectItem value="default">
                      Bags of {num(m.pieces_per_bag)} (usual size)
                    </SelectItem>
                  )}
                  {bagSizes
                    .filter((s) => s !== m?.pieces_per_bag)
                    .map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        Bags of {num(s)}
                      </SelectItem>
                    ))}
                  <SelectItem value="pieces">Pieces (mixed or loose stock)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {mode === "bags" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Full bags counted" hint={`${num(perBag ?? 0)} pieces each`}>
                <CountInput value={bags} onChange={setBags} placeholder="0" />
              </Field>
              <Field label="Loose pieces">
                <CountInput value={loose} onChange={setLoose} placeholder="0" />
              </Field>
            </div>
          ) : (
            <Field label="Pieces counted">
              <CountInput value={pieces} onChange={setPieces} placeholder="0" />
            </Field>
          )}
          {m && (
            <div className="grid grid-cols-3 gap-2 rounded-xl border p-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">System</div>
                <div className="font-medium">{num(m.current_stock)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Counted</div>
                <div className="font-medium">{counted == null ? "—" : num(counted)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Variance</div>
                <div
                  className={`font-semibold ${variance && variance < 0 ? "text-destructive" : variance ? "text-primary" : ""}`}
                >
                  {variance == null ? "—" : `${variance > 0 ? "+" : ""}${num(variance)}`}
                </div>
              </div>
            </div>
          )}
          {kind === "opening_balance" ? (
            <CostPerBagInput
              unitCost={unitCost}
              onChange={setUnitCost}
              perBag={perBag}
              unit={m?.unit}
            />
          ) : (
            <Field label="Reason">
              <Select value={reasonChoice} onValueChange={setReasonChoice}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUSTMENT_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label={kind === "opening_balance" ? "Explanation" : "Details"}>
            <Textarea rows={2} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
          </Field>
          <Field label="Count sheet / supporting reference">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. CS-2026-10-31"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !m || counted == null || !reference.trim() || reason.length < 5 || submit.isPending
            }
            onClick={() => submit.mutate(undefined, { onSuccess: onClose })}
          >
            {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit count
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
