import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generateInvoicePdf } from "@/lib/pdf";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

// Loads a saved sale with its line items and prints/downloads its invoice.
// Shared by the Sales page and the Accountant page so both produce the same
// document.
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
  await generateInvoicePdf(
    {
      company: {
        name: settings?.company_name ?? "Elim Table Water",
        address: settings?.address,
        phone: settings?.phone,
        email: settings?.email,
        logo_url: settings?.logo_url,
      },
      invoice_number: s.invoice_number,
      sale_date: s.sale_date,
      customer: { name: s.customer_name, phone: s.customer_phone, address: s.customer_address },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      items: (s.sale_items ?? []).map((it: any) => ({
        name: it.products?.name ?? "-",
        quantity: Number(it.quantity),
        unit: it.products?.unit ?? "",
        unit_price: Number(it.unit_price),
        line_total: Number(it.line_total),
      })),
      subtotal: Number(s.subtotal),
      discount: Number(s.discount),
      vat: Number(s.vat),
      grand_total: Number(s.grand_total),
      amount_paid: Number(s.amount_paid),
      balance: Number(s.balance),
      currency: settings?.currency ?? "NGN",
      remarks: s.remarks,
      sales_person: s.sales_person,
      is_pr: s.is_pr,
    },
    action,
  );
}
