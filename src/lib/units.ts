import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Fallback list used only if the units_of_measure table can't be reached —
// the real, admin-configurable list (Settings > Units of Measure) is what
// useUnitsOfMeasure() below returns. Every Select using either also offers a
// free-text "Other…" escape hatch.
export const UNIT_OPTIONS = [
  "kg",
  "g",
  "litres",
  "ml",
  "pieces",
  "units",
  "bags",
  "cartons",
  "pallets",
  "tons",
  "meters",
  "rolls",
  "sacks",
  "drums",
  "boxes",
];

// Packaging categories that only ever come in these two units. Matched
// against the admin-defined `material_categories.name` (case-insensitive),
// not a fixed category enum — factories can still add other categories,
// which keep the full unit list.
const CATEGORY_UNIT_OVERRIDES: Record<string, string[]> = {
  bottle: ["kilogram", "piece"],
  sachet: ["kilogram", "piece"],
  dispenser: ["kilogram", "piece"],
};

export function getUnitOptionsForCategory(
  categoryName: string | null | undefined,
  allUnits: string[],
): string[] {
  const override = categoryName
    ? CATEGORY_UNIT_OVERRIDES[categoryName.trim().toLowerCase()]
    : undefined;
  if (!override) return allUnits;
  const matched = allUnits.filter((u) => override.some((o) => u.toLowerCase().startsWith(o)));
  return matched.length > 0 ? matched : override.map((o) => o[0].toUpperCase() + o.slice(1));
}

export function useUnitsOfMeasure() {
  return useQuery({
    queryKey: ["units-of-measure"],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from("units_of_measure")
        .select("name")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []).map((u) => u.name);
    },
    staleTime: 60_000,
  });
}
