import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { num } from "@/lib/format";
import { formatBags, splitBags } from "@/lib/preform-units";

// Materials delivered in bags but counted in pieces (PET preforms of every
// size) have raw_materials.pieces_per_bag set. Quantities are always stored
// in pieces; these show them as pieces + bags and let them be entered as
// bags + loose pieces. Without a bag size they behave like a plain quantity.

export function BagQty({
  value,
  unit,
  perBag,
  className = "",
}: {
  value: number | null | undefined;
  unit?: string | null;
  perBag?: number | null;
  className?: string;
}) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const split = splitBags(Number(value), perBag);
  return (
    <span className={className}>
      {num(Number(value))} {unit ?? ""}
      {split && (
        <span className="block text-[11px] font-normal text-muted-foreground">
          {formatBags(split)}
        </span>
      )}
    </span>
  );
}

// "Bags" + "Loose pieces" when the material has a bag size; otherwise the
// usual quantity box. onChange always receives pieces.
export function BagQuantityInput({
  label,
  value,
  onChange,
  perBag,
  unit,
}: {
  label: string;
  value: number;
  onChange: (pieces: number) => void;
  perBag?: number | null;
  unit?: string | null;
}) {
  const start = splitBags(value, perBag);
  const [bags, setBags] = useState<number>(start?.bags ?? 0);
  const [loose, setLoose] = useState<number>(start?.pieces ?? 0);

  // Re-split when the value is changed from outside (e.g. a reset to 0).
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
        <MoneyInput min={0} step="0.001" value={value} onChange={onChange} />
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
            onChange={(e) => {
              const b = whole(e.target.value);
              setBags(b);
              onChange(b * perBag + loose);
            }}
          />
          <span className="text-[11px] text-muted-foreground">bags × {num(perBag)}</span>
        </div>
        <div>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={loose || ""}
            placeholder="0"
            onChange={(e) => {
              const p = whole(e.target.value);
              setLoose(p);
              onChange(bags * perBag + p);
            }}
          />
          <span className="text-[11px] text-muted-foreground">loose pieces</span>
        </div>
      </div>
      <p className="mt-1 text-xs font-medium">
        = {num(value)} {unit ?? "pieces"}
      </p>
    </div>
  );
}
