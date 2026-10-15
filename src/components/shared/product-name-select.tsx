import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The Water Factory's finished products. Picked from a list so the same
// product isn't entered under several spellings.
export const FINISHED_PRODUCT_NAMES = [
  "35cl Bottle Water",
  "50cl Bottle Water",
  "75cl Bottle Water",
  "1Ltr Bottle Water",
  "1.5Ltr Bottle Water",
  "Dispenser Water",
  "Jug + Water",
  "Empty Jug",
  "Sachet Water",
] as const;

const OTHER = "__other__";

// Product name as a dropdown of FINISHED_PRODUCT_NAMES. A name not on the list
// (an existing product being edited, or "Other…") is kept and editable.
export function ProductNameSelect({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (name: string) => void;
  autoFocus?: boolean;
}) {
  const listed = (FINISHED_PRODUCT_NAMES as readonly string[]).includes(value);
  const [other, setOther] = useState(!!value && !listed);

  return (
    <div className="space-y-2">
      <Select
        value={other ? OTHER : listed ? value : ""}
        onValueChange={(v) => {
          if (v === OTHER) {
            setOther(true);
            if (listed) onChange("");
          } else {
            setOther(false);
            onChange(v);
          }
        }}
      >
        <SelectTrigger autoFocus={autoFocus}>
          <SelectValue placeholder="Select product…" />
        </SelectTrigger>
        <SelectContent>
          {FINISHED_PRODUCT_NAMES.map((n) => (
            <SelectItem key={n} value={n}>
              {n}
            </SelectItem>
          ))}
          <SelectItem value={OTHER}>Other…</SelectItem>
        </SelectContent>
      </Select>
      {other && (
        <Input
          placeholder="Product name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
