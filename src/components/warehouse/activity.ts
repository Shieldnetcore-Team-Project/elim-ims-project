import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { printDispatchSlip } from "@/lib/dispatch-slip";
import {
  printSaleInvoice,
  REPRINT_LABEL,
  WAREHOUSE_SLIP_COPIES,
  warehouseSlipLabels,
} from "@/lib/invoice";

// Shared by the Warehouse's Recent activity card and its Activity Log tab.
export type Activity = {
  kind:
    | "received"
    | "refused"
    | "marketer"
    | "retail"
    | "distributor"
    | "sale"
    | "adjusted"
    | "returned"
    | "customer_return"
    | "jugs_returned"
    | "gift";
  reference: string;
  at: string;
  party: string | null;
  items: string | null;
  quantity: number;
  status: string;
  // warehouse_transactions (2026-11-02): whose row it is, to open their window.
  party_type?: "production" | "marketer" | "retail" | "distributor" | "walk_in";
  party_id?: string | null;
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
  returned: { label: "Returned to Warehouse", variant: "outline" },
  customer_return: { label: "Customer return", variant: "outline" },
  jugs_returned: { label: "Empty Dispenser Jugs returned", variant: "outline" },
  // Chairman's gifts (CGF-...), 2026-11-14.
  gift: { label: "Chairman's gift", variant: "secondary" },
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
  const isDispatch = a.kind === "marketer" || a.kind === "retail";
  const { data: firstPrint, error: claimError } = await supabase.rpc(
    "claim_warehouse_slip" as never,
    {
      p_factory: factoryId,
      p_document_kind: isDispatch ? "dispatch" : "sale",
      p_reference: a.reference,
    } as never,
  );
  if (claimError) {
    toast.error(`Couldn't record this print: ${claimError.message}`);
    return;
  }

  const labels =
    firstPrint === true
      ? warehouseSlipLabels(isDispatch ? (a.kind === "retail" ? "retail" : "marketer") : "customer")
      : [REPRINT_LABEL];
  const printCount = firstPrint === true ? WAREHOUSE_SLIP_COPIES : copies;

  if (isDispatch) {
    await printDispatchSlip(
      { number: a.reference },
      settings,
      "print",
      printCount,
      false,
      true,
      true,
      labels,
    );
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
  await printSaleInvoice(data.id, settings, "print", "roll", printCount, labels, true);
}

// Each Warehouse officer sees only the products they handle (user,
// 2026-11-02: Kemi bottles; Gideon dispensers and sachet) -- on screen.
// Printed and exported reports keep everything. `items` is "Name × qty, …":
// the lines for other products are dropped, and a row with none left is
// hidden. Empty-jug returns belong with the dispensers.
export function scopeToMyProducts<
  T extends { kind: string; items: string | null; quantity: number },
>(rows: T[], mine: (name: string) => boolean): T[] {
  const jugs = mine("Dispenser Water") || mine("Jug Water");
  const out: T[] = [];
  for (const r of rows) {
    if (r.kind === "jugs_returned") {
      if (jugs) out.push(r);
      continue;
    }
    if (!r.items) {
      out.push(r);
      continue;
    }
    const parts = r.items.split(", ");
    const kept = parts.filter((p) => mine(p.split(" × ")[0]));
    if (kept.length === 0) continue;
    if (kept.length === parts.length) {
      out.push(r);
      continue;
    }
    const qty = kept.reduce(
      (t, p) => t + (Number((p.split(" × ")[1] ?? "").replace(/[^\d.]/g, "")) || 0),
      0,
    );
    out.push({ ...r, items: kept.join(", "), quantity: qty });
  }
  return out;
}
