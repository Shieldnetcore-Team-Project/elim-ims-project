import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// What a marketer / the shop already returned to the Warehouse on a day, so a
// second entry for the same day shows the first and adds up to it, and each
// can be corrected from the same box (user, 2026-11-03). Cancelled returns
// (corrected or removed) don't count.
export type DayReturn = {
  id: string;
  return_number: string;
  return_date: string;
  received_at: string | null;
  status: string;
  // The posting it was added to; a return in a live posting is corrected
  // through that posting.
  carried: { dispatch_number: string; status: string } | null;
  rep_return_items:
    | {
        product_id: string;
        quantity_returned: number;
        products: { name: string; unit: string } | null;
      }[]
    | null;
};

export function useDayReturns(holderId: string | null | undefined, date: string) {
  const q = useQuery({
    queryKey: ["dist-returns", "day", holderId, date],
    enabled: !!holderId && !!date,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_returns")
        .select(
          "id,return_number,return_date,received_at,status,carried:stock_dispatches!rep_returns_carried_dispatch_id_fkey(dispatch_number,status),rep_return_items(product_id,quantity_returned,products(name,unit))",
        )
        .eq("sales_rep_id", holderId!)
        .eq("return_date", date)
        .neq("status", "cancelled")
        .order("received_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as DayReturn[];
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
    rows: q.data ?? [],
    byProduct,
    names,
    numbers: (q.data ?? []).map((r) => r.return_number),
    isLoading: q.isLoading,
    error: q.error as Error | null,
  };
}
