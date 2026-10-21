import type { ReportColumn } from "./export";
import { fetchAll } from "./metrics";

// "Items Sold to Customers" — the same layout as the old accounting package's
// printout: one block per customer (ID, name), one line per product with the
// quantity and amount sold in the period, a customer subtotal, and a grand
// total. Only posted, non-deleted, non-PR sales count — the same rule the
// dashboards use for revenue — so the printout agrees with the sales figures.
//
// The "customer" is who the goods went out to, as on the old printout: a
// marketer's sales (their own stock, or on their account) sit under the
// marketer and their SR code; a distributor's under the distributor and their
// DST code; anything else under the walk-in name typed on the sale.

export type ItemsSoldLine = {
  marketer?: { id: string; code: string | null; name: string } | null;
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  product: string;
  unit: string | null;
  quantity: number;
  amount: number;
};

export type ItemsSoldGroup = {
  key: string;
  code: string | null;
  name: string;
  items: { product: string; unit: string | null; quantity: number; amount: number }[];
  quantity: number;
  amount: number;
};

export type ItemsSoldReport = { groups: ItemsSoldGroup[]; quantity: number; amount: number };

const WALK_IN = "Walk-in customer";
const round2 = (v: number) => Math.round(v * 100) / 100;

// Marketer first, then registered customer; anything else (walk-in sales typed
// by name) groups by the name as written, case and spacing aside.
export function buildItemsSold(lines: ItemsSoldLine[]): ItemsSoldReport {
  const groups = new Map<string, ItemsSoldGroup>();
  for (const l of lines) {
    const typed = (l.customer_name ?? "").trim() || WALK_IN;
    const party = l.marketer
      ? { key: `rep:${l.marketer.id}`, code: l.marketer.code, name: l.marketer.name }
      : l.customer_id
        ? { key: l.customer_id, code: l.customer_code, name: typed }
        : {
            key: `name:${typed.toLowerCase().replace(/\s+/g, " ")}`,
            code: null,
            name: typed,
          };
    let g = groups.get(party.key);
    if (!g) {
      g = { ...party, code: party.code ?? null, items: [], quantity: 0, amount: 0 };
      groups.set(party.key, g);
    }
    let item = g.items.find((i) => i.product === l.product);
    if (!item) {
      item = { product: l.product, unit: l.unit, quantity: 0, amount: 0 };
      g.items.push(item);
    }
    item.quantity += Number(l.quantity) || 0;
    item.amount += Number(l.amount) || 0;
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.items.sort((a, b) => a.product.localeCompare(b.product));
    for (const i of g.items) {
      i.quantity = round2(i.quantity);
      i.amount = round2(i.amount);
    }
    g.quantity = round2(g.items.reduce((s, i) => s + i.quantity, 0));
    g.amount = round2(g.items.reduce((s, i) => s + i.amount, 0));
  }
  // Customers with an ID first, in ID order (as the printout); then by name.
  out.sort((a, b) =>
    a.code && b.code
      ? a.code.localeCompare(b.code, undefined, { numeric: true })
      : a.code
        ? -1
        : b.code
          ? 1
          : a.name.localeCompare(b.name),
  );
  return {
    groups: out,
    quantity: round2(out.reduce((s, g) => s + g.quantity, 0)),
    amount: round2(out.reduce((s, g) => s + g.amount, 0)),
  };
}

export const ITEMS_SOLD_COLUMNS: ReportColumn[] = [
  { key: "customer_code", label: "Customer ID" },
  { key: "customer_name", label: "Name" },
  { key: "product", label: "Item" },
  { key: "quantity", label: "Qty" },
  { key: "unit", label: "Stocking U/M" },
  { key: "amount", label: "Amount" },
];

// Flat rows for the on-screen table, CSV and Excel: the customer's ID and name
// on their first line only, then a subtotal line, and a grand total at the end.
// `kind` lets the screen and PDF style subtotal/total lines.
export function itemsSoldRows(report: ItemsSoldReport): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const g of report.groups) {
    g.items.forEach((i, idx) =>
      rows.push({
        kind: "item",
        customer_code: idx === 0 ? (g.code ?? "") : "",
        customer_name: idx === 0 ? g.name : "",
        product: i.product,
        quantity: i.quantity,
        unit: i.unit ?? "",
        amount: i.amount,
      }),
    );
    rows.push({
      kind: "subtotal",
      customer_code: "",
      customer_name: "",
      product: `Total — ${g.name}`,
      quantity: g.quantity,
      unit: "",
      amount: g.amount,
    });
  }
  if (report.groups.length > 0)
    rows.push({
      kind: "total",
      customer_code: "",
      customer_name: "",
      product: `GRAND TOTAL (${report.groups.length} customers)`,
      quantity: report.quantity,
      unit: "",
      amount: report.amount,
    });
  return rows;
}

// Reads every sale line in the period. `startDay`/`endDay` are yyyy-MM-dd
// (sale_date is a date column, so a local-midnight ISO timestamp would be cast
// back to the previous day in UTC and pull in a day too many).
export async function fetchItemsSold(
  db: any,
  factoryId: string,
  startDay: string | null,
  endDay: string | null,
): Promise<ItemsSoldReport> {
  const raw = await fetchAll<any>((a, b) => {
    let q: any = db
      .from("sale_items")
      .select(
        "id,quantity,line_total,products(name,unit),sales!inner(factory_id,sale_date,status,deleted_at,is_pr,customer_id,customer_name,customers(code)," +
          "seller:sales_reps!sales_sales_rep_id_fkey(id,code,full_name,kind),owner:sales_reps!sales_account_rep_id_fkey(id,code,full_name,kind))",
      )
      .eq("sales.factory_id", factoryId)
      .eq("sales.status", "posted")
      .is("sales.deleted_at", null)
      .eq("sales.is_pr", false)
      .order("id")
      .range(a, b);
    if (startDay) q = q.gte("sales.sale_date", startDay);
    if (endDay) q = q.lte("sales.sale_date", endDay);
    return q;
  });
  return buildItemsSold(
    raw.map((r) => {
      // Same rule as the printed invoice: the marketer on the account, else
      // the marketer whose stock it came from. Retail outlets aren't marketers.
      const rep = [r.sales?.owner, r.sales?.seller].find((x) => x?.kind === "rep");
      return {
        marketer: rep ? { id: rep.id, code: rep.code ?? null, name: rep.full_name } : null,
        customer_id: r.sales?.customer_id ?? null,
        customer_code: r.sales?.customers?.code ?? null,
        customer_name: r.sales?.customer_name ?? null,
        product: r.products?.name ?? "—",
        unit: r.products?.unit ?? null,
        quantity: Number(r.quantity),
        amount: Number(r.line_total),
      };
    }),
  );
}
