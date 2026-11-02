import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { num } from "@/lib/format";
import { useMyProductMatcher } from "@/lib/product-rules";

// What was last supplied to a marketer / the shop (Warehouse postings) or a
// Distributor/Office Delivery customer (Warehouse sales), shown on the return
// forms so the return is entered against it (user, 2026-11-02). The most
// recent supply day, every posting that day summed per product -- a marketer
// can be loaded several times a day. Quantities only, no money.

type Line = { product_id: string; name: string; unit: string; qty: number };
export type Supplied = { date: string; references: string[]; lines: Line[] };

type Row = {
  date: string;
  reference: string;
  items: {
    product_id: string;
    quantity: number;
    products: { name: string; unit: string } | null;
  }[];
};

const lastDay = (rows: Row[]): Supplied | null => {
  if (rows.length === 0) return null;
  const date = rows[0].date;
  const day = rows.filter((r) => r.date === date);
  const byProduct = new Map<string, Line>();
  for (const r of day)
    for (const it of r.items) {
      const l = byProduct.get(it.product_id) ?? {
        product_id: it.product_id,
        name: it.products?.name ?? "—",
        unit: it.products?.unit ?? "",
        qty: 0,
      };
      l.qty += Number(it.quantity);
      byProduct.set(it.product_id, l);
    }
  return {
    date,
    references: day.map((r) => r.reference),
    lines: [...byProduct.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
};

export function useLastSupplied(kind: "marketer" | "customer", id: string | null | undefined) {
  return useQuery({
    queryKey: ["last-supplied", kind, id],
    enabled: !!id,
    queryFn: async (): Promise<Supplied | null> => {
      if (kind === "marketer") {
        const { data, error } = await supabase
          .from("stock_dispatches")
          .select(
            "dispatch_date,dispatch_number,status,stock_dispatch_items(product_id,quantity,products(name,unit))",
          )
          .eq("sales_rep_id", id!)
          .is("reversed_at", null)
          .order("dispatch_date", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(20);
        if (error) throw error;
        return lastDay(
          (
            (data ?? []) as unknown as {
              dispatch_date: string;
              dispatch_number: string;
              status: string;
              stock_dispatch_items: Row["items"];
            }[]
          )
            .filter((d) => d.status !== "reversed" && d.status !== "cancelled")
            .map((d) => ({
              date: String(d.dispatch_date).slice(0, 10),
              reference: d.dispatch_number,
              items: d.stock_dispatch_items ?? [],
            })),
        );
      }
      const { data, error } = await supabase
        .from("sales")
        .select("sale_date,invoice_number,sale_items(product_id,quantity,products(name,unit))")
        .eq("customer_id", id!)
        .is("sales_rep_id", null)
        .is("deleted_at", null)
        .eq("status", "posted")
        .order("sale_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return lastDay(
        (
          (data ?? []) as unknown as {
            sale_date: string;
            invoice_number: string;
            sale_items: Row["items"];
          }[]
        ).map((s) => ({
          date: String(s.sale_date).slice(0, 10),
          reference: s.invoice_number,
          items: s.sale_items ?? [],
        })),
      );
    },
  });
}

export function LastSuppliedPanel({
  kind,
  id,
}: {
  kind: "marketer" | "customer";
  id: string | null | undefined;
}) {
  const q = useLastSupplied(kind, id);
  // Only this officer's products, as the rest of the form.
  const mine = useMyProductMatcher();
  if (!id) return null;
  const lines = (q.data?.lines ?? []).filter((l) => mine(l.name));
  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-sm">
      <div className="font-medium">
        Last supplied
        {q.data && (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {new Date(`${q.data.date}T12:00:00`).toLocaleDateString()} ·{" "}
            {q.data.references.join(", ")}
          </span>
        )}
      </div>
      {q.isLoading ? (
        <div className="mt-1 text-muted-foreground">Loading…</div>
      ) : q.isError ? (
        <div className="mt-1 text-destructive">{(q.error as Error).message}</div>
      ) : lines.length === 0 ? (
        <div className="mt-1 text-muted-foreground">Nothing supplied yet.</div>
      ) : (
        <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {lines.map((l) => (
            <li key={l.product_id} className="flex justify-between gap-2">
              <span>{l.name}</span>
              <span className="font-medium">
                {num(l.qty)} {l.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
