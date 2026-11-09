import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// The products the signed-in person handles in the Warehouse (user, 2026-11-01:
// Kemi bottles, Gideon dispensers and sachet), as name patterns from
// my_product_rules (20261101140000). No rules -> every product. The database
// refuses the others anyway; this keeps them out of the lists.
export async function fetchMyProductPatterns(): Promise<RegExp[]> {
  const { data, error } = await supabase.rpc("my_product_rules" as never);
  if (error) return []; // before the database update: no limit
  const patterns = ((data ?? []) as unknown as { name_pattern: string }[]).map((r) => {
    try {
      return new RegExp(r.name_pattern, "i");
    } catch {
      return null;
    }
  });
  return patterns.filter((p): p is RegExp => !!p);
}

export async function fetchMyProductMatcher(): Promise<(name: string) => boolean> {
  const patterns = await fetchMyProductPatterns();
  return (name: string) => handlesProduct(patterns, name);
}

export const handlesProduct = (patterns: RegExp[], name: string) =>
  patterns.length === 0 || patterns.some((re) => re.test(name));

export const acceptsOwnRelease = (patterns: RegExp[], name: string) =>
  /sachet|satchet/i.test(name) && patterns.some((re) => re.test(name));

// May this person accept a Production release they released themselves? Only
// Sachet Water, and only someone assigned to it by name (user, 2026-11-09:
// Gideon does the whole sachet run alone). A person with no rules is not
// "assigned", so this can't use the matcher above. accept_production_release
// makes the same check (_may_accept_own_release, 20261109100000).
export function useMayAcceptOwnRelease(): (productName: string) => boolean {
  const q = useQuery({
    queryKey: ["my-product-patterns"],
    queryFn: fetchMyProductPatterns,
    staleTime: 60_000,
  });
  const patterns = q.data ?? [];
  return (name: string) => acceptsOwnRelease(patterns, name);
}

// Assigned to dispensers by name (Gideon). A person with no rules is not
// "assigned". He sees the totals on his posting form (user, 2026-11-09).
export function useAssignedToDispensers(): boolean {
  const q = useQuery({
    queryKey: ["my-product-patterns"],
    queryFn: fetchMyProductPatterns,
    staleTime: 60_000,
  });
  return (q.data ?? []).some((re) => re.test("Dispenser Water"));
}

export function useMyProductMatcher(): (name: string) => boolean {
  const q = useQuery({
    queryKey: ["my-product-rules"],
    queryFn: fetchMyProductMatcher,
    staleTime: 60_000,
  });
  // Nothing until the rules are in, so an officer never sees another's
  // products for a moment while the page loads.
  return q.data ?? (() => false);
}

// What finished product line a QC item (empty bottle, preform, jug) feeds,
// so the item can be checked against the person's product rules (user,
// 2026-11-04: Ruth sees only what QC sends for bottle water). Jugs go to
// dispenser production, sachet film to sachet, everything else QC hands
// over (blown bottles, preforms, caps) to bottle water.
export function qcItemLine(name: string): string {
  const n = name.toLowerCase();
  if (/jug|dispenser/.test(n)) return "Dispenser Water";
  if (/sachet/.test(n)) return "Sachet Water";
  return "Bottle Water";
}
