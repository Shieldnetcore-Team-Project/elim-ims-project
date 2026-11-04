import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generateDispatchSlipPdf } from "@/lib/pdf";
import { generateDistributorInvoicePdf } from "@/lib/distributor-invoice";
import { INVOICE_COMPANY_NAME, warehouseSlipLabels } from "@/lib/invoice";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

type Dispatch = {
  id: string;
  dispatch_number: string;
  dispatch_date: string;
  created_at: string | null;
  status: string;
  total_value: number;
  notes: string | null;
  created_by: string | null;
  sales_reps: { full_name: string; code: string | null; kind: string; phone: string | null } | null;
  items: { name: string; unit: string; quantity: number; unit_price: number; line_value: number }[];
};

// A posting to a marketer / the retail shop (by id or posting number) with
// its lines. The lines come through rep_posting_lines(): an accountant can't
// read products directly, so the product names would otherwise print as "—".
async function loadDispatch(ref: { id: string } | { number: string }): Promise<Dispatch | null> {
  let q = supabase
    .from("stock_dispatches")
    .select(
      "id,dispatch_number,dispatch_date,created_at,status,total_value,notes,created_by,sales_reps(full_name,code,kind,phone),stock_dispatch_items(quantity,unit_price,line_value,products(name,unit))",
    );
  q = "id" in ref ? q.eq("id", ref.id) : q.eq("dispatch_number", ref.number);
  const { data, error } = await q.maybeSingle();
  if (error || !data) {
    toast.error(error?.message ?? "Posting not found");
    return null;
  }
  const d = data as unknown as Omit<Dispatch, "items"> & {
    stock_dispatch_items: {
      quantity: number;
      unit_price: number;
      line_value: number;
      products: { name: string; unit: string } | null;
    }[];
  };
  const { data: lines } = await supabase.rpc(
    "rep_posting_lines" as never,
    { p_kind: "dispatch", p_id: d.id } as never,
  );
  const viaRpc = (lines ?? []) as unknown as {
    product_name: string;
    unit: string;
    quantity: number;
    unit_price: number;
    line_total: number;
  }[];
  const items = viaRpc.length
    ? viaRpc.map((l) => ({
        name: l.product_name,
        unit: l.unit,
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        line_value: Number(l.line_total),
      }))
    : (d.stock_dispatch_items ?? []).map((it) => ({
        name: it.products?.name ?? "—",
        unit: it.products?.unit ?? "",
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
        line_value: Number(it.line_value),
      }));
  return { ...d, items };
}

const companyOf = (settings: Settings) => ({
  name: INVOICE_COMPANY_NAME,
  address: settings?.address,
  phone: settings?.phone,
  email: settings?.email,
  logo_url: settings?.logo_url,
});

// Prints or downloads a posting's slip (the slim load order receipt). Shared
// by every list of postings so they all print the same document.
export async function printDispatchSlip(
  ref: { id: string } | { number: string },
  settings: Settings,
  action: "download" | "print",
  copies = 1,
  // Items and quantities only (printed outside Accounts).
  quantitiesOnly = false,
  // The Warehouse's labelled copies (Warehouse Copy, then Marketer / Retail
  // Shop Copy), 2026-11-04.
  labelled = false,
) {
  const d = await loadDispatch(ref);
  if (!d) return;
  let postedBy: string | null = null;
  if (d.created_by) {
    const { data: p } = await supabase
      .from("profiles")
      .select("full_name,email")
      .eq("id", d.created_by)
      .maybeSingle();
    postedBy = p?.full_name || p?.email || null;
  }

  await generateDispatchSlipPdf(
    {
      company: companyOf(settings),
      dispatch_number: d.dispatch_number,
      dispatch_date: d.dispatch_date,
      created_at: d.created_at,
      holder: {
        name: d.sales_reps?.full_name ?? "—",
        code: d.sales_reps?.code,
        kind: d.sales_reps?.kind,
      },
      status: d.status,
      items: d.items,
      total_value: Number(d.total_value),
      notes: d.notes,
      posted_by: postedBy,
      currency: settings?.currency ?? "NGN",
      quantities_only: quantitiesOnly,
      copy_labels: labelled
        ? warehouseSlipLabels(d.sales_reps?.kind === "outlet" ? "retail" : "marketer")
        : undefined,
    },
    action,
    copies,
  );
}

// The same posting on the company's A4 invoice (user, 2026-11-02: Accounts
// prints it for each posting, as for a distributor's sale): billed to the
// marketer or the shop, their ID, the products at the posted prices. Paid
// shows 0 -- a marketer settles through remittances, not on the posting.
export async function printDispatchInvoice(
  ref: { id: string } | { number: string },
  settings: Settings,
  action: "download" | "print",
) {
  const d = await loadDispatch(ref);
  if (!d) return;
  const total = Number(d.total_value);
  await generateDistributorInvoicePdf(
    {
      company: { ...companyOf(settings), website: settings?.website ?? null },
      invoice_number: d.dispatch_number,
      issued_at: d.created_at ?? d.dispatch_date,
      customer: { name: d.sales_reps?.full_name ?? "—", phone: d.sales_reps?.phone ?? null },
      party_id: d.sales_reps?.code ?? null,
      party_label: d.sales_reps?.kind === "outlet" ? "Retail Shop" : null,
      delivery_method:
        d.sales_reps?.kind === "outlet" ? "Company Delivery" : "Delivered by Marketer",
      items: d.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unit_price: it.unit_price,
        line_total: it.line_value,
      })),
      subtotal: total,
      discount: 0,
      vat: 0,
      vat_rate: null,
      grand_total: total,
      amount_paid: 0,
      balance: total,
      remarks:
        [d.status === "reversed" ? "REVERSED" : null, d.notes].filter(Boolean).join(". ") || null,
    },
    action,
  );
}

// A marketer's / the shop's whole day as ONE invoice (user, 2026-11-03):
// everything posted (lines of the same product and price added together).
// What they returned that day is taken off the matching product's line --
// never printed as a line of its own (user, 2026-11-04) -- and a line left
// at 0 drops off; the total is the net. Reversed postings are left out.
export async function printDispatchDayInvoice(
  ids: string[],
  settings: Settings,
  action: "download" | "print",
  returnIds: string[] = [],
) {
  const all = await Promise.all(ids.map((id) => loadDispatch({ id })));
  const live = all.filter((d): d is NonNullable<typeof d> => !!d && d.status !== "reversed");
  if (live.length === 0) return;
  if (live.length === 1 && returnIds.length === 0)
    return printDispatchInvoice({ id: ids[all.indexOf(live[0])] }, settings, action);
  const first = live[0];
  type Item = { name: string; quantity: number; unit_price: number; line_total: number };
  const lines = new Map<string, Item>();
  for (const d of live)
    for (const it of d.items) {
      const key = `${it.name}|${it.unit_price}`;
      const l = lines.get(key) ?? {
        name: it.name,
        quantity: 0,
        unit_price: it.unit_price,
        line_total: 0,
      };
      l.quantity += Number(it.quantity);
      l.line_total += Number(it.line_value);
      lines.set(key, l);
    }
  // The day's returns, through rep_posting_lines (Accounts can't read
  // products directly), come off the posted lines of the same product.
  const returnedQty = new Map<string, number>();
  for (const id of returnIds) {
    const { data: rl } = await supabase.rpc(
      "rep_posting_lines" as never,
      { p_kind: "return", p_id: id } as never,
    );
    for (const l of (rl ?? []) as unknown as { product_name: string; quantity: number }[])
      returnedQty.set(l.product_name, (returnedQty.get(l.product_name) ?? 0) + Number(l.quantity));
  }
  for (const [name, qty] of returnedQty) {
    let left = qty;
    for (const l of lines.values()) {
      if (left <= 0) break;
      if (l.name !== name || l.quantity <= 0) continue;
      const take = Math.min(left, l.quantity);
      l.quantity -= take;
      l.line_total -= take * l.unit_price;
      left -= take;
    }
  }
  for (const [k, l] of lines) if (l.quantity <= 0) lines.delete(k);
  if (lines.size === 0) return;
  const net = [...lines.values()].reduce((t, l) => t + l.line_total, 0);
  const latest = live
    .map((d) => d.created_at ?? d.dispatch_date)
    .sort()
    .at(-1)!;
  await generateDistributorInvoicePdf(
    {
      company: { ...companyOf(settings), website: settings?.website ?? null },
      invoice_number:
        live.length > 1 ? `${first.dispatch_number} +${live.length - 1}` : first.dispatch_number,
      issued_at: latest,
      customer: {
        name: first.sales_reps?.full_name ?? "—",
        phone: first.sales_reps?.phone ?? null,
      },
      party_id: first.sales_reps?.code ?? null,
      party_label: first.sales_reps?.kind === "outlet" ? "Retail Shop" : null,
      delivery_method:
        first.sales_reps?.kind === "outlet" ? "Company Delivery" : "Delivered by Marketer",
      items: [...lines.values()],
      subtotal: net,
      discount: 0,
      vat: 0,
      vat_rate: null,
      grand_total: net,
      amount_paid: 0,
      balance: net,
      remarks: `${first.dispatch_date}: posted ${live.map((d) => d.dispatch_number).join(", ")}`,
    },
    action,
  );
}
