import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
  // Dispenser water and jug water are one product, kept in new and old jugs.
  "Dispenser/Jug Water (New Jug)",
  "Dispenser/Jug Water (Old Jug)",
  "Sachet Water",
] as const;

// Selling price per pack, filled in when one of these products is created; the
// price is kept on the product (unit_price), so posting and selling pick it up
// automatically. Change it on the product (Finished Products → Edit).
export const DEFAULT_PRICE: Partial<Record<(typeof FINISHED_PRODUCT_NAMES)[number], number>> = {
  "35cl Bottle Water": 2550,
  "50cl Bottle Water": 2650,
  "75cl Bottle Water": 1700,
  "1.5Ltr Bottle Water": 1700,
};

export const defaultPriceFor = (name: string) =>
  DEFAULT_PRICE[name.trim() as (typeof FINISHED_PRODUCT_NAMES)[number]];

// The three product categories, and which one each listed product goes in.
export const WATER_CATEGORIES = ["Bottle Water", "Dispenser/Jug Water", "Sachet Water"] as const;

export function categoryForProduct(name: string): (typeof WATER_CATEGORIES)[number] | undefined {
  const n = name.trim().toLowerCase();
  if (n.includes("sachet") || n.includes("satchet")) return "Sachet Water";
  if (n.includes("dispenser") || n.includes("jug")) return "Dispenser/Jug Water";
  if (n.includes("bottle")) return "Bottle Water";
  return undefined;
}

// Throws if this factory already has a product of that name (ignoring case and
// surrounding spaces) other than `excludeId`. The database enforces the same
// rule (products_factory_name_unique); this gives the clear message first.
export async function assertUniqueProductName(factoryId: string, name: string, excludeId?: string) {
  const { data, error } = await supabase
    .from("products")
    .select("id,name")
    .eq("factory_id", factoryId);
  if (error) throw error;
  const key = name.trim().toLowerCase();
  const twin = (data ?? []).find((p) => p.id !== excludeId && p.name.trim().toLowerCase() === key);
  if (twin)
    throw new Error(`"${twin.name}" already exists — edit that product instead of adding it again`);
}

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
