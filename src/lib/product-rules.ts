import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// The products the signed-in person handles in the Warehouse (user, 2026-11-01:
// Kemi bottles, Gideon dispensers and sachet), as name patterns from
// my_product_rules (20261101140000). No rules -> every product. The database
// refuses the others anyway; this keeps them out of the lists.
export async function fetchMyProductMatcher(): Promise<(name: string) => boolean> {
  const { data, error } = await supabase.rpc("my_product_rules" as never);
  if (error) return () => true; // before the database update: no limit
  const patterns = ((data ?? []) as unknown as { name_pattern: string }[]).map((r) => {
    try {
      return new RegExp(r.name_pattern, "i");
    } catch {
      return null;
    }
  });
  const valid = patterns.filter((p): p is RegExp => !!p);
  if (valid.length === 0) return () => true;
  return (name: string) => valid.some((re) => re.test(name));
}

export function useMyProductMatcher(): (name: string) => boolean {
  const q = useQuery({
    queryKey: ["my-product-rules"],
    queryFn: fetchMyProductMatcher,
    staleTime: 60_000,
  });
  return q.data ?? (() => true);
}
