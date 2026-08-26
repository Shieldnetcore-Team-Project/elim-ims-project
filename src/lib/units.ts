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
