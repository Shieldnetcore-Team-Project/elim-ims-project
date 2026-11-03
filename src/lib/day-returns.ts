import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// What a marketer / the shop already returned to the Warehouse on a day, so a
// second entry for the same day shows the first and adds up to it (user,
// 2026-11-03). Cancelled returns don't count.
export function useDayReturns(holderId: string | null | undefined, date: string) {
  const q = useQuery({
    queryKey: ["dist-returns", "day", holderId, date],
    enabled: !!holderId && !!date,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_returns")
        .select("return_number,rep_return_items(product_id,quantity_returned,products(name,unit))")
        .eq("sales_rep_id", holderId!)
        .eq("return_date", date)
        .neq("status", "cancelled");
      if (error) throw error;
      return (data ?? []) as unknown as {
        return_number: string;
        rep_return_items:
          | {
              product_id: string;
              quantity_returned: number;
              products: { name: string; unit: string } | null;
            }[]
          | null;
      }[];
    },
  });
  const byProduct = new Map<string, number>();
  const names = new Map<string, { name: string; unit: string }>();
  for (const r of q.data ?? [])
    for (const i of r.rep_return_items ?? []) {
      byProduct.set(i.product_id, (byProduct.get(i.product_id) ?? 0) + Number(i.quantity_returned));
      if (i.products) names.set(i.product_id, i.products);
    }
  return {
    byProduct,
    names,
    numbers: (q.data ?? []).map((r) => r.return_number),
    isLoading: q.isLoading,
  };
}
