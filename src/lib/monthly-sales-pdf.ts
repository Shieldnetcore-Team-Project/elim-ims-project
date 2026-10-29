import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { drawLogoHeader, pdfMoney, type PdfAction } from "./pdf";
import { fetchSaleLines } from "./invoice";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

type Sale = {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_name: string | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
  sale_items:
    | { quantity: number; line_total: number; products: { name: string; unit: string } | null }[]
    | null;
};

// The Accountant's monthly accumulated sales (A4): the month's posted invoices
// added up -- totals, then by product, by customer and by day. PR /
// complimentary invoices are left out (nothing billed). With `customer` it is
// that one customer's month (from the customer activity view): the customer
// table is replaced by their invoices.
// month: "YYYY-MM".
export async function printMonthlySales(
  factoryId: string,
  month: string,
  settings: Settings,
  action: PdfAction,
  customer?: string | null,
) {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // 1st of next month
  const sales: Sale[] = [];
  // Page through: a busy month can pass the API's 1000-row cap.
  for (let start = 0; ; start += 1000) {
    let q = supabase
      .from("sales")
      .select(
        "id,invoice_number,sale_date,customer_name,grand_total,amount_paid,balance,sale_items(quantity,line_total,products(name,unit))",
      )
      .eq("factory_id", factoryId)
      .is("deleted_at", null)
      .eq("status", "posted")
      .eq("is_pr", false)
      .gte("sale_date", from)
      .lt("sale_date", to);
    if (customer)
      q = q.ilike(
        "customer_name",
        customer.replace(/[\\%_]/g, (c) => `\\${c}`),
      );
    const { data, error } = await q
      .order("sale_date")
      .order("created_at")
      .range(start, start + 999);
    if (error) {
      toast.error(error.message);
      return;
    }
    sales.push(...((data ?? []) as unknown as Sale[]));
    if ((data ?? []).length < 1000) break;
  }
  if (sales.length === 0) {
    toast.info("No posted sales in that month.");
    return;
  }
  // Product names through sale_invoice_lines() (see fetchSaleLines), 1000 sales
  // per call.
  for (let i = 0; i < sales.length; i += 1000) {
    const chunk = sales.slice(i, i + 1000);
    const lines = await fetchSaleLines(chunk.map((s) => s.id));
    for (const s of chunk) {
      const own = lines?.get(s.id);
      if (own)
        s.sale_items = own.map((l) => ({
          quantity: l.quantity,
          line_total: l.line_total,
          products: { name: l.name, unit: l.unit },
        }));
    }
  }

  const currency = settings?.currency ?? "NGN";
  const cash = (n: number) => pdfMoney(n, currency);
  const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });

  type Sum = { invoices: number; total: number; paid: number; balance: number };
  const add = (s: Sum, x: Sale) => {
    s.invoices += 1;
    s.total += Number(x.grand_total);
    s.paid += Number(x.amount_paid);
    s.balance += Number(x.balance);
  };
  const blank = (): Sum => ({ invoices: 0, total: 0, paid: 0, balance: 0 });
  const all = blank();
  const products = new Map<string, { name: string; unit: string; qty: number; amount: number }>();
  const customers = new Map<string, Sum & { name: string; qty: Map<string, number> }>();
  const days = new Map<string, Sum>();
  for (const s of sales) {
    add(all, s);
    const day = s.sale_date.slice(0, 10);
    if (!days.has(day)) days.set(day, blank());
    add(days.get(day)!, s);
    const name = s.customer_name?.trim() || "Walk-in";
    const ck = name.toLowerCase();
    if (!customers.has(ck)) customers.set(ck, { ...blank(), name, qty: new Map() });
    const c = customers.get(ck)!;
    add(c, s);
    for (const it of s.sale_items ?? []) {
      const pname = it.products?.name ?? "Item";
      const unit = it.products?.unit ?? "";
      const p = products.get(pname) ?? { name: pname, unit, qty: 0, amount: 0 };
      p.qty += Number(it.quantity);
      p.amount += Number(it.line_total);
      products.set(pname, p);
      c.qty.set(pname, (c.qty.get(pname) ?? 0) + Number(it.quantity));
    }
  }

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 40;
  let top = await drawLogoHeader(doc, settings?.logo_url, 40, 130, 60);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text((settings?.company_name ?? "Elim Table Water").toUpperCase(), pageW / 2, top, {
    align: "center",
  });
  top += 16;
  doc.setFontSize(11);
  doc.text(
    customer ? `Monthly Sales Statement — ${customer}` : "Monthly Accumulated Sales",
    pageW / 2,
    top,
    { align: "center" },
  );
  top += 15;
  doc.text(monthLabel, pageW / 2, top, { align: "center" });
  top += 12;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Posted invoices only (PR / complimentary excluded).", M, top);
  top += 10;

  const table = (title: string, head: string[], body: string[][], foot?: string[]) => {
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    const startY = last ? last.finalY + 22 : top + 8;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(title, M, startY - 6);
    const right = head
      .map((h, i) => i)
      .filter((i) => i > 0 && /amount|total|paid|balance|qty|invoices/i.test(head[i]));
    autoTable(doc, {
      startY,
      head: [head],
      body,
      foot: foot ? [foot] : undefined,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 8.5, cellPadding: 3 },
      headStyles: { fillColor: [30, 41, 59] },
      footStyles: { fillColor: [226, 232, 240], textColor: [0, 0, 0], fontStyle: "bold" },
      columnStyles: Object.fromEntries(right.map((i) => [i, { halign: "right" as const }])),
      margin: { left: M, right: M, top: 40 },
    });
  };

  table(
    "Summary",
    ["", "Invoices", "Total sales", "Amount paid", "Balance"],
    [["Month", num(all.invoices), cash(all.total), cash(all.paid), cash(all.balance)]],
  );

  const prodRows = [...products.values()].sort((a, b) => b.amount - a.amount);
  table(
    "Sales by product",
    ["Product", "Unit", "Qty", "Amount"],
    prodRows.map((p) => [p.name, p.unit, num(p.qty), cash(p.amount)]),
    ["Total", "", "", cash(prodRows.reduce((t, p) => t + p.amount, 0))],
  );

  if (customer) {
    table(
      "Invoices",
      ["Date", "Invoice #", "Products", "Total", "Paid", "Balance"],
      sales.map((s) => [
        s.sale_date.slice(0, 10),
        s.invoice_number,
        (s.sale_items ?? [])
          .map((it) => `${it.products?.name ?? "Item"} × ${num(Number(it.quantity))}`)
          .join(", "),
        cash(Number(s.grand_total)),
        cash(Number(s.amount_paid)),
        cash(Number(s.balance)),
      ]),
      ["Total", "", "", cash(all.total), cash(all.paid), cash(all.balance)],
    );
  } else {
    const custRows = [...customers.values()].sort((a, b) => b.total - a.total);
    table(
      "Sales by customer",
      ["Customer", "Products", "Invoices", "Total", "Paid", "Balance"],
      custRows.map((c) => [
        c.name,
        [...c.qty].map(([n, q]) => `${n} × ${num(q)}`).join(", "),
        num(c.invoices),
        cash(c.total),
        cash(c.paid),
        cash(c.balance),
      ]),
      ["Total", "", num(all.invoices), cash(all.total), cash(all.paid), cash(all.balance)],
    );
  }

  table(
    "Sales by day",
    ["Date", "Invoices", "Total", "Paid", "Balance"],
    [...days].map(([d, s]) => [d, num(s.invoices), cash(s.total), cash(s.paid), cash(s.balance)]),
    ["Total", num(all.invoices), cash(all.total), cash(all.paid), cash(all.balance)],
  );

  const printedAt = new Date().toLocaleString();
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(printedAt, M, 24);
    doc.text(`Page ${p} of ${pages}`, pageW - M, 24, { align: "right" });
  }

  const file = `monthly-sales-${month}${customer ? `-${customer.replace(/[^\w-]+/g, "-")}` : ""}.pdf`;
  if (action === "download") {
    doc.save(file);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
