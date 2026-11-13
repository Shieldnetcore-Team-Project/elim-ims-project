import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/components/preform/api";
import { num } from "@/lib/format";
import { useMyProductMatcher } from "@/lib/product-rules";
import { saleLineName } from "@/lib/sale-line-name";

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
    jar_mode?: string | null;
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
      const name = saleLineName(it.products?.name, it.jar_mode);
      const l = byProduct.get(`${it.product_id}|${name}`) ?? {
        product_id: it.product_id,
        name,
        unit: it.products?.unit ?? "",
        qty: 0,
      };
      l.qty += Number(it.quantity);
      byProduct.set(`${it.product_id}|${name}`, l);
    }
  return {
    date,
    references: day.map((r) => r.reference),
    lines: [...byProduct.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
};

// With `day`, only what was supplied on that day (returns entered per supply
// day, back-dated -- user, 2026-11-10); null when nothing went out that day.
export function useLastSupplied(
  kind: "marketer" | "customer",
  id: string | null | undefined,
  day?: string,
) {
  return useQuery({
    queryKey: ["last-supplied", kind, id, day ?? null],
    enabled: !!id,
    queryFn: async (): Promise<Supplied | null> => {
      if (kind === "marketer") {
        let mq = supabase
          .from("stock_dispatches")
          .select(
            "dispatch_date,dispatch_number,status,stock_dispatch_items(product_id,quantity,jar_mode,products(name,unit))",
          )
          .eq("sales_rep_id", id!)
          .is("reversed_at", null);
        if (day) mq = mq.eq("dispatch_date", day);
        const { data, error } = await mq
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
      let sq = supabase
        .from("sales")
        .select(
          "sale_date,invoice_number,sale_items(product_id,quantity,jar_mode,products(name,unit))",
        )
        .eq("customer_id", id!)
        .is("sales_rep_id", null)
        .is("deleted_at", null)
        .eq("status", "posted");
      if (day) sq = sq.eq("sale_date", day);
      const { data, error } = await sq
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
  day,
}: {
  kind: "marketer" | "customer";
  id: string | null | undefined;
  day?: string;
}) {
  const q = useLastSupplied(kind, id, day);
  // Only this officer's products, as the rest of the form.
  const mine = useMyProductMatcher();
  if (!id) return null;
  const lines = (q.data?.lines ?? []).filter((l) => mine(l.name));
  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-sm">
      <div className="font-medium">
        {day ? `Supplied on ${new Date(`${day}T12:00:00`).toLocaleDateString()}` : "Last supplied"}
        {q.data && (
          <span className="font-normal text-muted-foreground">
            {" "}
            {!day && `· ${new Date(`${q.data.date}T12:00:00`).toLocaleDateString()} `}·{" "}
            {q.data.references.join(", ")}
          </span>
        )}
      </div>
      {q.isLoading ? (
        <div className="mt-1 text-muted-foreground">Loading…</div>
      ) : q.isError ? (
        <div className="mt-1 text-destructive">{(q.error as Error).message}</div>
      ) : lines.length === 0 ? (
        <div className="mt-1 text-muted-foreground">
          {day ? "Nothing supplied on this day." : "Nothing supplied yet."}
        </div>
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
      {kind === "customer" && day && <DayReturnsList customerId={id} day={day} mine={mine} />}
    </div>
  );
}

// Under a Distributor/Office Delivery customer's supply day: each return made
// for that day, oldest first, one line per return (SR- number) and product
// (user, 2026-11-13: "total supplied 440 and returned 19 at the top").
// Cancelled returns are left out.
function DayReturnsList({
  customerId,
  day,
  mine,
}: {
  customerId: string;
  day: string;
  mine: (name: string) => boolean;
}) {
  const q = useQuery({
    queryKey: ["jug", "customer-day-return-list", customerId, day],
    queryFn: async () => {
      const { data, error } = await db
        .from("sales_returns")
        .select("return_number,created_at,quantity_returned,status,product_id,products(name,unit)")
        .eq("customer_id", customerId)
        .eq("return_date", day)
        .neq("status", "cancelled")
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as unknown as {
        return_number: string;
        created_at: string;
        quantity_returned: number;
        product_id: string;
        products: { name: string; unit: string } | null;
      }[];
      const out = new Map<
        string,
        { ref: string; at: string; name: string; unit: string; qty: number }
      >();
      for (const r of rows) {
        const ref = r.return_number.replace(/-\d+$/, "");
        const key = `${ref}|${r.product_id}`;
        const l = out.get(key) ?? {
          ref,
          at: r.created_at,
          name: r.products?.name ?? "—",
          unit: r.products?.unit ?? "",
          qty: 0,
        };
        l.qty += Number(r.quantity_returned);
        out.set(key, l);
      }
      return [...out.values()];
    },
  });
  const rows = (q.data ?? []).filter((r) => mine(r.name));
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 border-t pt-2">
      <div className="font-medium">Returned for this day</div>
      <ul className="mt-1 grid gap-0.5">
        {rows.map((r) => (
          <li key={`${r.ref}|${r.name}`} className="flex justify-between gap-2">
            <span>
              {r.name}
              <span className="text-[11px] text-muted-foreground">
                {" "}
                · {r.ref} · {new Date(r.at).toLocaleString()}
              </span>
            </span>
            <span className="font-medium">
              {num(r.qty)} {r.unit}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
