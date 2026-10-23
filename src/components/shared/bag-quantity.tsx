import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { money, num } from "@/lib/format";
import { formatBags, formatGrams, formatWeight, packPlural, splitBags } from "@/lib/preform-units";

// Materials delivered in bags but counted in pieces (PET preforms of every
// size) have raw_materials.pieces_per_bag set. The Store receives them in
// bags; stock is always stored in pieces (bags x pieces per bag) and issued
// to Production / QC in pieces. Without a bag size these behave like a plain
// quantity.

export const isPreform = (name: string | null | undefined) => /preform/i.test(name ?? "");

// A quantity with its bag equivalent. bagsFirst: "40 bags" with the pieces
// underneath (how the Store counts preforms); otherwise pieces first.
export function BagQty({
  value,
  unit,
  perBag,
  bagsFirst,
  pack,
  className = "",
}: {
  value: number | null | undefined;
  unit?: string | null;
  perBag?: number | null;
  bagsFirst?: boolean;
  pack?: string;
  className?: string;
}) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const split = splitBags(Number(value), perBag);
  const pieces = `${num(Number(value))} ${unit ?? ""}`;
  if (split && bagsFirst) {
    return (
      <span className={className}>
        {formatBags(split, pack)}
        <span className="block text-[11px] font-normal text-muted-foreground">{pieces}</span>
      </span>
    );
  }
  return (
    <span className={className}>
      {pieces}
      {split && (
        <span className="block text-[11px] font-normal text-muted-foreground">
          {formatBags(split, pack)}
        </span>
      )}
    </span>
  );
}

// Entry in bags (+ any loose pieces) when the material has a bag size;
// otherwise the usual quantity box. onChange always receives pieces.
// `pack` names the pack for materials not bought in bags ("carton", "roll").
export function BagQuantityInput({
  label,
  value,
  onChange,
  perBag,
  unit,
  pack = "bag",
  disabled,
}: {
  label: string;
  value: number;
  onChange: (pieces: number) => void;
  perBag?: number | null;
  unit?: string | null;
  pack?: string;
  disabled?: boolean;
}) {
  const start = splitBags(value, perBag);
  const [bags, setBags] = useState<number>(start?.bags ?? 0);
  const [loose, setLoose] = useState<number>(start?.pieces ?? 0);

  // Re-split when the value or the bag size changes from outside.
  useEffect(() => {
    if (!perBag) return;
    if (bags * perBag + loose !== value) {
      const s = splitBags(value, perBag);
      setBags(s?.bags ?? 0);
      setLoose(s?.pieces ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, perBag]);

  if (!perBag) {
    return (
      <div>
        <Label>{label}</Label>
        <MoneyInput min={0} step="0.001" value={value} onChange={onChange} disabled={disabled} />
      </div>
    );
  }
  const whole = (raw: string) => (raw === "" ? 0 : Math.max(0, Math.floor(Number(raw))));
  return (
    <div>
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={bags || ""}
            placeholder="0"
            disabled={disabled}
            onChange={(e) => {
              const b = whole(e.target.value);
              setBags(b);
              onChange(b * perBag + loose);
            }}
          />
          <span className="text-[11px] text-muted-foreground">
            {packPlural(pack)} ({num(perBag)} pcs each)
          </span>
        </div>
        <div>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={loose || ""}
            placeholder="0"
            disabled={disabled}
            onChange={(e) => {
              const p = whole(e.target.value);
              setLoose(p);
              onChange(bags * perBag + p);
            }}
          />
          <span className="text-[11px] text-muted-foreground">+ loose pieces, if any</span>
        </div>
      </div>
      <p className="mt-1 text-xs font-medium">
        = {num(value)} {unit ?? "pieces"} into stock
      </p>
    </div>
  );
}

// Pieces entry (issuing to Production / QC) with the bag equivalent.
export function PiecesInput({
  label,
  value,
  onChange,
  perBag,
  unit,
  pack,
}: {
  label: string;
  value: number;
  onChange: (pieces: number) => void;
  perBag?: number | null;
  unit?: string | null;
  pack?: string;
}) {
  const split = splitBags(value, perBag);
  return (
    <div>
      <Label>
        {label}
        {perBag ? " (pieces)" : ""}
      </Label>
      <MoneyInput min={0} step={perBag ? "1" : "0.001"} value={value} onChange={onChange} />
      {split && value > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          = {formatBags(split, pack)} of {num(perBag ?? 0)} {unit ?? "pieces"}
        </p>
      )}
    </div>
  );
}

// Cost per bag on a delivery, kept as cost per piece (what the Store values
// stock at). Without a bag size: the plain unit-cost box.
export function CostPerBagInput({
  unitCost,
  onChange,
  perBag,
  unit,
  pack = "bag",
}: {
  unitCost: number;
  onChange: (perPiece: number) => void;
  perBag?: number | null;
  unit?: string | null;
  pack?: string;
}) {
  const [perBagCost, setPerBagCost] = useState(
    perBag ? Math.round(unitCost * perBag * 100) / 100 : 0,
  );
  useEffect(() => {
    if (perBag) setPerBagCost(Math.round(unitCost * perBag * 100) / 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perBag]);
  if (!perBag) {
    return (
      <div>
        <Label>Unit cost</Label>
        <MoneyInput value={unitCost} onChange={onChange} />
      </div>
    );
  }
  return (
    <div>
      <Label>Cost per {pack}</Label>
      <MoneyInput
        value={perBagCost}
        onChange={(v) => {
          setPerBagCost(v);
          onChange(v / perBag);
        }}
      />
      <p className="mt-1 text-[11px] text-muted-foreground">
        = {money(unitCost)} per {unit?.toLowerCase() ?? "piece"}
      </p>
    </div>
  );
}

// First delivery of a preform with no bag size: set it here (a figure the
// Store can change later with a reason) before entering bags.
export function BagSizeSetup({
  materialId,
  materialName,
  onSaved,
}: {
  materialId: string;
  materialName: string;
  onSaved: (perBag: number) => void;
}) {
  const [value, setValue] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { error } = await (supabase as any).rpc("set_material_pieces_per_bag", {
        p_material: materialId,
        p_pieces_per_bag: value,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${materialName}: ${num(value ?? 0)} pieces per bag`);
      onSaved(value ?? 0);
    },
    onError: (e: Error) =>
      toast.error(
        e.message.includes("Insufficient")
          ? "Ask the Store to set pieces per bag for this preform first"
          : e.message,
      ),
  });
  return (
    <div className="rounded-lg border border-warning/50 bg-warning/5 p-3">
      <p className="text-sm font-medium">How many pieces are in one bag of {materialName}?</p>
      <p className="text-xs text-muted-foreground">
        Preforms are received in bags and kept in pieces. Set this once; it applies to every later
        delivery and issue.
      </p>
      <div className="mt-2 flex gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          placeholder="e.g. 1152"
          value={value ?? ""}
          onChange={(e) =>
            setValue(e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))))
          }
        />
        <Button type="button" disabled={!value || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}

// A preform's weight (raw_materials.grams_per_piece), shown wherever the
// preform is picked, with the total weight of the pieces being entered. When
// no weight is set yet and the user may set it (canSet), it is entered here
// once; later changes are made on the preform's setup with a reason.
export function PreformGrams({
  materialId,
  materialName,
  grams,
  pieces,
  canSet,
  onSaved,
}: {
  materialId: string;
  materialName: string;
  grams: number | null | undefined;
  pieces?: number;
  canSet?: boolean;
  onSaved?: (grams: number) => void;
}) {
  const [value, setValue] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { error } = await (supabase as any).rpc("set_material_grams", {
        p_material: materialId,
        p_grams: value,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${materialName}: ${formatGrams(value)} per preform`);
      onSaved?.(value ?? 0);
    },
    onError: (e: Error) =>
      toast.error(
        e.message.includes("Insufficient")
          ? "Ask the Store to set the grams for this preform"
          : e.message,
      ),
  });

  if (grams && grams > 0) {
    const total = pieces && pieces > 0 ? formatWeight(pieces, grams) : null;
    return (
      <p className="text-xs text-muted-foreground">
        Weight: <span className="font-medium text-foreground">{formatGrams(grams)}</span> per
        preform
        {total && (
          <>
            {" "}
            · {num(pieces ?? 0)} pcs ≈ <span className="font-medium text-foreground">{total}</span>
          </>
        )}
      </p>
    );
  }
  if (!canSet)
    return <p className="text-xs text-muted-foreground">No weight (grams) set for this preform.</p>;
  return (
    <div className="rounded-lg border p-3">
      <p className="text-sm font-medium">How many grams is one {materialName}?</p>
      <p className="text-xs text-muted-foreground">
        Set once; it comes along wherever this preform is picked. Stock stays in pieces.
      </p>
      <div className="mt-2 flex gap-2">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.1"
          placeholder="e.g. 18"
          value={value ?? ""}
          onChange={(e) =>
            setValue(e.target.value === "" ? null : Math.max(0, Number(e.target.value)))
          }
        />
        <Button type="button" disabled={!value || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
