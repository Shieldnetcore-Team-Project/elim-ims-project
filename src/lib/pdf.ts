import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { money } from "./format";

export type InvoiceItem = {
  name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
};

export type InvoiceData = {
  company: { name: string; address?: string | null; phone?: string | null; email?: string | null };
  invoice_number: string;
  sale_date: string;
  customer: { name?: string | null; phone?: string | null; address?: string | null };
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  vat: number;
  grand_total: number;
  amount_paid: number;
  balance: number;
  currency?: string;
  remarks?: string | null;
  sales_person?: string | null;
};

export function generateInvoicePdf(data: InvoiceData) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = data.currency ?? "NGN";

  doc.setFontSize(18);
  doc.text(data.company.name || "FMIS", 40, 50);
  doc.setFontSize(10);
  let y = 68;
  if (data.company.address) { doc.text(data.company.address, 40, y); y += 14; }
  const line2 = [data.company.phone, data.company.email].filter(Boolean).join(" · ");
  if (line2) { doc.text(line2, 40, y); y += 14; }

  doc.setFontSize(20);
  doc.text("INVOICE", 555, 50, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${data.invoice_number}`, 555, 68, { align: "right" });
  doc.text(`Date: ${data.sale_date}`, 555, 82, { align: "right" });

  y = Math.max(y, 100);
  doc.setFontSize(11);
  doc.text("Bill To:", 40, y);
  doc.setFontSize(10);
  doc.text(data.customer.name || "Walk-in customer", 40, y + 14);
  if (data.customer.phone) doc.text(data.customer.phone, 40, y + 28);
  if (data.customer.address) doc.text(data.customer.address, 40, y + 42);

  autoTable(doc, {
    startY: y + 60,
    head: [["#", "Item", "Qty", "Unit", "Price", "Total"]],
    body: data.items.map((it, i) => [
      String(i + 1),
      it.name,
      it.quantity.toString(),
      it.unit,
      money(it.unit_price, currency),
      money(it.line_total, currency),
    ]),
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  const endY: number = doc.lastAutoTable.finalY + 20;
  const labelX = 400, valueX = 555;
  const rows: [string, string][] = [
    ["Subtotal", money(data.subtotal, currency)],
    ["Discount", money(data.discount, currency)],
    ["VAT", money(data.vat, currency)],
    ["Grand Total", money(data.grand_total, currency)],
    ["Amount Paid", money(data.amount_paid, currency)],
    ["Balance Due", money(data.balance, currency)],
  ];
  rows.forEach(([l, v], i) => {
    if (l === "Grand Total") doc.setFont("helvetica", "bold"); else doc.setFont("helvetica", "normal");
    doc.text(l, labelX, endY + i * 16);
    doc.text(v, valueX, endY + i * 16, { align: "right" });
  });
  doc.setFont("helvetica", "normal");

  if (data.remarks) {
    doc.text(`Remarks: ${data.remarks}`, 40, endY + rows.length * 16 + 20);
  }
  if (data.sales_person) {
    doc.text(`Sales Person: ${data.sales_person}`, 40, endY + rows.length * 16 + 36);
  }

  doc.setFontSize(9);
  doc.text("Thank you for your business.", 40, 800);

  doc.save(`${data.invoice_number}.pdf`);
}

export function generateReceiptPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  receipt_number: string;
  payment_date: string;
  customer_name?: string | null;
  amount: number;
  payment_method: string;
  remarks?: string | null;
  currency?: string;
}) {
  const doc = new jsPDF({ unit: "pt", format: "a5" });
  const currency = opts.currency ?? "NGN";
  doc.setFontSize(16); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, 66);
  if (opts.company.phone) doc.text(opts.company.phone, 40, 80);

  doc.setFontSize(18); doc.text("RECEIPT", 380, 50, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.receipt_number}`, 380, 66, { align: "right" });
  doc.text(`Date: ${opts.payment_date}`, 380, 80, { align: "right" });

  doc.setFontSize(11);
  doc.text(`Received from: ${opts.customer_name ?? "—"}`, 40, 130);
  doc.text(`Payment method: ${opts.payment_method}`, 40, 150);
  doc.setFontSize(20);
  doc.text(`Amount: ${money(opts.amount, currency)}`, 40, 185);
  doc.setFontSize(10);
  if (opts.remarks) doc.text(`Remarks: ${opts.remarks}`, 40, 210);
  doc.save(`${opts.receipt_number}.pdf`);
}
