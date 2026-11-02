import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generateDispatchSlipPdf } from "@/lib/pdf";
import { generateDistributorInvoicePdf } from "@/lib/distributor-invoice";
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
  name: settings?.company_name ?? "Elim Table Water",
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
