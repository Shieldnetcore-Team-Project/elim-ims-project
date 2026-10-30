import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generateInvoicePdf } from "@/lib/pdf";
import { generateDistributorInvoicePdf } from "@/lib/distributor-invoice";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- customers.code and sales.account_rep_id are newer than the generated types
const db = supabase as any;

type Rep = { id: string; code: string | null; name: string; kind: string };

export type SaleLine = {
  name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
  item_id?: string;
  // Given on the line after posting (adjust_sale_lines): per pack (unit_*)
  // and the line totals (quantity x per pack); line_total is net.
  unit_discount?: number;
  unit_surcharge?: number;
  discount?: number;
  surcharge?: number;
};

// The product lines of the given sales, by sale id, read through
// sale_invoice_lines() -- products and sale_items are readable only with
// finished-goods / sales rights, which an accountant may not hold, so a plain
// select came back without product lines. Null when the function can't be
// used (no sales/finance rights); callers then fall back to their own select.
export async function fetchSaleLines(saleIds: string[]): Promise<Map<string, SaleLine[]> | null> {
  if (saleIds.length === 0) return new Map();
  const { data, error } = await db.rpc("sale_invoice_lines", { p_sales: saleIds });
  if (error) return null;
  const out = new Map<string, SaleLine[]>();
  for (const r of (data ?? []) as {
    sale_id: string;
    product_name: string;
    unit: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    item_id?: string;
    discount?: number;
    surcharge?: number;
    unit_discount?: number;
    unit_surcharge?: number;
  }[]) {
    const list = out.get(r.sale_id) ?? [];
    list.push({
      name: r.product_name,
      quantity: Number(r.quantity),
      unit: r.unit,
      unit_price: Number(r.unit_price),
      line_total: Number(r.line_total),
      item_id: r.item_id,
      discount: Number(r.discount ?? 0),
      surcharge: Number(r.surcharge ?? 0),
      unit_discount: Number(r.unit_discount ?? 0),
      unit_surcharge: Number(r.unit_surcharge ?? 0),
    });
    out.set(r.sale_id, list);
  }
  return out;
}

// Loads a saved sale with its line items and prints/downloads its invoice.
// Shared by every page that prints a sale so they all produce the same
// document:
//   marketer / distributor sale  the full A4 invoice (distributor-invoice.ts)
//                                -- the sale was made from a marketer's stock,
//                                belongs to a marketer's account, or went to
//                                a registered customer (distributor)
//   anything else                the plain sales receipt (walk-in, retail shop)
// paper "roll": the Warehouse's slim POS printer -- always the receipt layout
// on an 80mm roll, never the A4 distributor invoice.
// Several sale ids print as ONE combined invoice (the Accountant's daily
// invoice for a marketer/distributor who takes supplies many times a day):
// lines for the same product at the same price are added together, totals are
// summed and the remarks list every invoice number covered. The layout and
// the party come from the earliest sale.
export async function printSaleInvoice(
  saleId: string | string[],
  settings: Settings,
  action: "download" | "print",
  paper: "a4" | "roll" = "a4",
  // Slim receipt only: identical pages in one print.
  copies = 1,
) {
  const ids = Array.isArray(saleId) ? saleId : [saleId];
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(quantity,unit_price,line_total,products(name,unit))")
    .in("id", ids);
  if (error) {
    toast.error(error.message);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sales = ((data ?? []) as any[]).sort((a, b) =>
    String(a.created_at ?? a.sale_date).localeCompare(String(b.created_at ?? b.sale_date)),
  );
  if (sales.length === 0) {
    toast.error("Invoice not found");
    return;
  }
  const s = sales[0];
  const combined = sales.length > 1;
  const merged: SaleLine[] = [];
  const fetched = await fetchSaleLines(sales.map((x) => x.id));
  for (const sale of sales) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const own: SaleLine[] = ((sale.sale_items ?? []) as any[]).map((it) => ({
      name: it.products?.name ?? "-",
      quantity: Number(it.quantity),
      unit: it.products?.unit ?? "",
      unit_price: Number(it.unit_price),
      line_total: Number(it.line_total),
    }));
    for (const it of fetched?.get(sale.id) ?? own) {
      const line = {
        ...it,
        unit_discount: it.unit_discount ?? 0,
        unit_surcharge: it.unit_surcharge ?? 0,
      };
      const same = merged.find(
        (l) =>
          l.name === line.name &&
          l.unit_price === line.unit_price &&
          l.unit_discount === line.unit_discount &&
          l.unit_surcharge === line.unit_surcharge,
      );
      if (same) {
        same.quantity += line.quantity;
        same.line_total += line.line_total;
      } else merged.push(line);
    }
  }
  // A line's per-pack discount / surcharge (adjust_sale_lines) is not shown
  // on the printout (user, 2026-10-29): the unit cost prints as the final
  // price per pack, so quantity x cost = amount and the totals add up.
  const lines = merged.map((l) => ({
    ...l,
    unit_price: l.unit_price - (l.unit_discount ?? 0) + (l.unit_surcharge ?? 0),
  }));
  const sum = (f: string) => sales.reduce((t, x) => t + Number(x[f] ?? 0), 0);
  const totals = {
    subtotal: sum("subtotal"),
    discount: sum("discount"),
    vat: sum("vat"),
    grand_total: sum("grand_total"),
    amount_paid: sum("amount_paid"),
    balance: sum("balance"),
  };
  const remarks =
    [
      combined
        ? `Combined invoice for ${String(s.sale_date).slice(0, 10)} covering ${sales.length} invoices: ${sales
            .map((x) => x.invoice_number)
            .join(", ")}`
        : null,
      ...new Set(sales.map((x) => x.remarks as string | null).filter(Boolean)),
    ]
      .filter(Boolean)
      .join(". ") || null;
  // A combined invoice is for the day, so it prints the date only.
  const issuedAt = combined ? String(s.sale_date).slice(0, 10) : (s.created_at ?? s.sale_date);
  const company = {
    name: settings?.company_name ?? "Elim Table Water",
    address: settings?.address,
    phone: settings?.phone,
    email: settings?.email,
    logo_url: settings?.logo_url,
  };

  // Who the sale belongs to.
  // Who the sale belongs to, read through sale_invoice_party() so an
  // accountant without distribution/customers/logistics rights still gets
  // the right layout.
  const { data: party, error: partyError } = await db.rpc("sale_invoice_party", { p_sale: s.id });
  if (partyError) {
    toast.error(partyError.message);
    return;
  }
  const seller = (party?.seller ?? null) as Rep | null;
  const owner = (party?.owner ?? null) as Rep | null;
  const marketer = [seller, owner].find((r) => r?.kind === "rep") ?? null;
  const customer = (party?.customer ?? null) as {
    code: string | null;
    registered: boolean;
    address: string | null;
  } | null;
  const isDistributor = !!customer?.registered;

  if (paper === "a4" && (marketer || (isDistributor && seller?.kind !== "outlet"))) {
    // ID shown: the marketer's when the goods came from their stock, else the
    // distributor's own; a walk-in on a marketer's account shows the marketer.
    const partyIsDistributor = isDistributor && seller?.kind !== "rep";
    const delivery = party?.delivered
      ? "Company Delivery"
      : seller?.kind === "rep"
        ? "Delivered by Marketer"
        : "Direct Delivery";
    await generateDistributorInvoicePdf(
      {
        company: { ...company, website: settings?.website ?? null },
        invoice_number: s.invoice_number,
        issued_at: issuedAt,
        customer: {
          name: s.customer_name,
          phone: s.customer_phone,
          address: s.customer_address ?? customer?.address,
        },
        party_id: partyIsDistributor ? (customer?.code ?? null) : (marketer?.code ?? null),
        party_label: partyIsDistributor ? null : (marketer?.name ?? null),
        delivery_method: delivery,
        items: lines,
        ...totals,
        vat_rate: settings?.vat_rate ?? null,
        remarks,
        is_pr: s.is_pr,
      },
      action,
    );
    return;
  }

  // The slim receipt's "Sales Rep.": the sales person typed in, else whoever
  // posted it.
  let poster: string | null = s.sales_person ?? null;
  if (paper === "roll" && !poster && s.created_by) {
    const { data: p } = await supabase
      .from("profiles")
      .select("full_name,email")
      .eq("id", s.created_by)
      .maybeSingle();
    poster = p?.full_name || p?.email || null;
  }

  await generateInvoicePdf(
    {
      company,
      invoice_number: s.invoice_number,
      sale_date: s.sale_date,
      issued_at: combined ? null : (s.created_at ?? null),
      sales_person: poster,
      retail: seller?.kind === "outlet",
      customer: { name: s.customer_name, phone: s.customer_phone, address: s.customer_address },
      items: lines,
      ...totals,
      currency: settings?.currency ?? "NGN",
      remarks,
      is_pr: s.is_pr,
    },
    action,
    paper,
    copies,
  );
}
