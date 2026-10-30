import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { printDispatchSlip } from "@/lib/dispatch-slip";
import { printSaleInvoice } from "@/lib/invoice";

// Shared by the Warehouse's Recent activity card and its Activity Log tab.
export type Activity = {
  kind: "received" | "refused" | "marketer" | "retail" | "distributor" | "sale" | "adjusted";
  reference: string;
  at: string;
  party: string | null;
  items: string | null;
  quantity: number;
  status: string;
};

export const KIND: Record<
  Activity["kind"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  received: { label: "Received from Production", variant: "default" },
  refused: { label: "Refused to Production", variant: "destructive" },
  marketer: { label: "Posted to Marketer", variant: "secondary" },
  retail: { label: "Posted to Retail Shop", variant: "secondary" },
  distributor: { label: "Posted to Distributor", variant: "secondary" },
  sale: { label: "Sold from Warehouse", variant: "outline" },
  adjusted: { label: "Stock correction", variant: "outline" },
};

// Which activities have a slip to print: postings print their dispatch slip;
// a distributor posting or direct sale is a sale, so it prints its invoice.
export const hasSlip = (a: Activity) =>
  a.kind === "marketer" || a.kind === "retail" || a.kind === "distributor" || a.kind === "sale";

export async function printWarehouseActivity(
  a: Activity,
  factoryId: string,
  settings: Parameters<typeof printSaleInvoice>[1],
  copies: number,
) {
  if (a.kind === "marketer" || a.kind === "retail") {
    await printDispatchSlip({ number: a.reference }, settings, "print", copies);
    return;
  }
  const { data, error } = await supabase
    .from("sales")
    .select("id")
    .eq("factory_id", factoryId)
    .eq("invoice_number", a.reference)
    .maybeSingle();
  if (error || !data) {
    toast.error(error?.message ?? "Invoice not found");
    return;
  }
  await printSaleInvoice(data.id, settings, "print", "roll", copies);
}
