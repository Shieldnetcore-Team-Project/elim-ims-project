import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generateInvoicePdf } from "@/lib/pdf";
import { generateDistributorInvoicePdf } from "@/lib/distributor-invoice";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- customers.code and sales.account_rep_id are newer than the generated types
const db = supabase as any;

type Rep = { id: string; code: string | null; name: string; kind: string };

// Loads a saved sale with its line items and prints/downloads its invoice.
// Shared by every page that prints a sale so they all produce the same
// document:
//   marketer / distributor sale  the full A4 invoice (distributor-invoice.ts)
//                                -- the sale was made from a marketer's stock,
//                                belongs to a marketer's account, or went to
//                                a registered customer (distributor)
//   anything else                the plain sales receipt (walk-in, retail shop)
export async function printSaleInvoice(
  saleId: string,
  settings: Settings,
  action: "download" | "print",
) {
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(quantity,unit_price,line_total,products(name,unit))")
    .eq("id", saleId)
    .single();
  if (error) {
    toast.error(error.message);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = (s.sale_items ?? []).map((it: any) => ({
    name: it.products?.name ?? "-",
    quantity: Number(it.quantity),
    unit: it.products?.unit ?? "",
    unit_price: Number(it.unit_price),
    line_total: Number(it.line_total),
  }));
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
  const { data: party, error: partyError } = await db.rpc("sale_invoice_party", { p_sale: saleId });
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

  if (marketer || (isDistributor && seller?.kind !== "outlet")) {
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
        issued_at: s.created_at ?? s.sale_date,
        customer: {
          name: s.customer_name,
          phone: s.customer_phone,
          address: s.customer_address ?? customer?.address,
        },
        party_id: partyIsDistributor ? (customer?.code ?? null) : (marketer?.code ?? null),
        party_label: partyIsDistributor ? null : (marketer?.name ?? null),
        delivery_method: delivery,
        items: lines,
        subtotal: Number(s.subtotal),
        discount: Number(s.discount),
        vat: Number(s.vat),
        vat_rate: settings?.vat_rate ?? null,
        grand_total: Number(s.grand_total),
        amount_paid: Number(s.amount_paid),
        balance: Number(s.balance),
        remarks: s.remarks,
        is_pr: s.is_pr,
      },
      action,
    );
    return;
  }

  await generateInvoicePdf(
    {
      company,
      invoice_number: s.invoice_number,
      sale_date: s.sale_date,
      customer: { name: s.customer_name, phone: s.customer_phone, address: s.customer_address },
      items: lines,
      subtotal: Number(s.subtotal),
      discount: Number(s.discount),
      vat: Number(s.vat),
      grand_total: Number(s.grand_total),
      amount_paid: Number(s.amount_paid),
      balance: Number(s.balance),
      currency: settings?.currency ?? "NGN",
      remarks: s.remarks,
      is_pr: s.is_pr,
    },
    action,
  );
}
