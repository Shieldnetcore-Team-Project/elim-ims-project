import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generateDispatchSlipPdf } from "@/lib/pdf";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

// Loads a posting to a marketer / the retail shop (by id or posting number)
// with its lines and prints or downloads its slip. Shared by every list of
// postings so they all print the same document.
export async function printDispatchSlip(
  ref: { id: string } | { number: string },
  settings: Settings,
  action: "download" | "print",
) {
  let q = supabase
    .from("stock_dispatches")
    .select(
      "id,dispatch_number,dispatch_date,created_at,status,total_value,notes,created_by,sales_reps(full_name,code,kind),stock_dispatch_items(quantity,unit_price,line_value,products(name,unit))",
    );
  q = "id" in ref ? q.eq("id", ref.id) : q.eq("dispatch_number", ref.number);
  const { data, error } = await q.maybeSingle();
  if (error || !data) {
    toast.error(error?.message ?? "Posting not found");
    return;
  }
  const d = data as unknown as {
    dispatch_number: string;
    dispatch_date: string;
    created_at: string | null;
    status: string;
    total_value: number;
    notes: string | null;
    created_by: string | null;
    sales_reps: { full_name: string; code: string | null; kind: string } | null;
    stock_dispatch_items: {
      quantity: number;
      unit_price: number;
      line_value: number;
      products: { name: string; unit: string } | null;
    }[];
  };
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
      company: {
        name: settings?.company_name ?? "Elim Table Water",
        address: settings?.address,
        phone: settings?.phone,
        email: settings?.email,
        logo_url: settings?.logo_url,
      },
      dispatch_number: d.dispatch_number,
      dispatch_date: d.dispatch_date,
      created_at: d.created_at,
      holder: {
        name: d.sales_reps?.full_name ?? "—",
        code: d.sales_reps?.code,
        kind: d.sales_reps?.kind,
      },
      status: d.status,
      items: (d.stock_dispatch_items ?? []).map((it) => ({
        name: it.products?.name ?? "—",
        quantity: Number(it.quantity),
        unit: it.products?.unit ?? "",
        unit_price: Number(it.unit_price),
        line_value: Number(it.line_value),
      })),
      total_value: Number(d.total_value),
      notes: d.notes,
      posted_by: postedBy,
      currency: settings?.currency ?? "NGN",
    },
    action,
  );
}
