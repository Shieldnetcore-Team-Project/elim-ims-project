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
  company: { name: string; address?: string | null; phone?: string | null; email?: string | null; logo_url?: string | null };
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

export type PdfAction = "download" | "print" | "preview";

// jsPDF's built-in fonts have no glyph for the Naira sign (₦) -- it prints as
// a broken box on thermal/receipt output. Use a plain currency-code prefix
// for PDFs instead of the on-screen Intl currency symbol from format.ts.
const pdfMoney = (n: number, currency: string) => {
  const v = typeof n === "number" ? n : 0;
  const formatted = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
  return `${v < 0 ? "-" : ""}${currency} ${formatted}`;
};

// Decodes the logo into a same-origin canvas so it can be embedded via
// addImage regardless of source format (png/jpg/webp all normalize to PNG).
// Resolves to null on any failure (missing logo, CORS, bad URL) so a broken
// logo never blocks printing a sale.
async function loadLogo(url: string): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("logo failed to load"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { dataUrl: canvas.toDataURL("image/png"), width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  }
}

// 80mm thermal POS paper width. Height is computed from content (see
// `draw` below run once against a tall scratch doc, then again against a
// doc sized exactly to fit) so the receipt prints like a real till slip
// instead of a mostly-blank A4/A5 page.
export async function generateInvoicePdf(data: InvoiceData, action: PdfAction = "download") {
  const currency = data.currency ?? "NGN";
  const cur = (n: number) => pdfMoney(n, currency);
  const logo = data.company.logo_url ? await loadLogo(data.company.logo_url) : null;

  const W = 227;
  const M = 10;
  const contentW = W - M * 2;
  const center = W / 2;

  const draw = (doc: jsPDF): number => {
    let y = M;

    if (logo) {
      const maxW = 90, maxH = 50;
      const ratio = Math.min(maxW / logo.width, maxH / logo.height, 1);
      const w = logo.width * ratio, h = logo.height * ratio;
      doc.addImage(logo.dataUrl, "PNG", center - w / 2, y, w, h);
      y += h + 6;
    }

    doc.setFont("helvetica", "bold"); doc.setFontSize(12);
    doc.text(data.company.name || "Company", center, y, { align: "center" }); y += 14;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    if (data.company.address) { doc.text(data.company.address, center, y, { align: "center" }); y += 11; }
    const contact = [data.company.phone, data.company.email].filter(Boolean).join(" · ");
    if (contact) { doc.text(contact, center, y, { align: "center" }); y += 11; }

    y += 4;
    doc.setLineDashPattern([2, 1], 0);
    doc.line(M, y, W - M, y); y += 12;
    doc.setLineDashPattern([], 0);

    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text("SALES RECEIPT", center, y, { align: "center" }); y += 14;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.text(`Invoice: ${data.invoice_number}`, M, y); y += 11;
    doc.text(`Date: ${data.sale_date}`, M, y); y += 11;

    doc.line(M, y, W - M, y); y += 12;

    doc.text(`Customer: ${data.customer.name || "Walk-in"}`, M, y); y += 11;
    if (data.customer.phone) { doc.text(`Phone: ${data.customer.phone}`, M, y); y += 11; }

    doc.line(M, y, W - M, y); y += 12;

    data.items.forEach((it) => {
      const nameLines: string[] = doc.splitTextToSize(it.name, contentW);
      nameLines.forEach((ln) => { doc.text(ln, M, y); y += 10; });
      doc.text(`${it.quantity} ${it.unit} x ${cur(it.unit_price)}`, M, y);
      doc.text(cur(it.line_total), W - M, y, { align: "right" });
      y += 12;
    });

    doc.line(M, y, W - M, y); y += 12;

    const row = (label: string, value: string, bold = false, size = 8) => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size);
      doc.text(label, M, y);
      doc.text(value, W - M, y, { align: "right" });
      y += bold ? 16 : 12;
    };
    row("Subtotal", cur(data.subtotal));
    if (data.discount > 0) row("Discount", `-${cur(data.discount)}`);
    if (data.vat > 0) row("VAT", cur(data.vat));
    row("GRAND TOTAL", cur(data.grand_total), true, 10);
    row("Amount Paid", cur(data.amount_paid));
    row("Balance Due", cur(data.balance), data.balance > 0);

    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.line(M, y, W - M, y); y += 12;

    if (data.sales_person) { doc.text(`Sales person: ${data.sales_person}`, M, y); y += 11; }
    if (data.remarks) {
      const remarkLines: string[] = doc.splitTextToSize(`Remarks: ${data.remarks}`, contentW);
      remarkLines.forEach((ln) => { doc.text(ln, M, y); y += 10; });
    }

    y += 6;
    doc.setFont("helvetica", "bold");
    doc.text("Thank you for your patronage!", center, y, { align: "center" }); y += 14;

    return y;
  };

  const scratch = new jsPDF({ unit: "pt", format: [W, 2000] });
  const finalY = draw(scratch);

  const doc = new jsPDF({ unit: "pt", format: [W, finalY + M] });
  draw(doc);

  if (action === "download") {
    doc.save(`${data.invoice_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export function generateReceiptPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  receipt_number: string;
  payment_date: string;
  customer_name?: string | null;
  invoice_number?: string | null;
  amount: number;
  payment_method: string;
  received_by?: string | null;
  remarks?: string | null;
  currency?: string;
}, action: PdfAction = "download") {
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
  let y = 130;
  doc.text(`Received from: ${opts.customer_name ?? "—"}`, 40, y); y += 18;
  if (opts.invoice_number) { doc.text(`Invoice: ${opts.invoice_number}`, 40, y); y += 18; }
  doc.text(`Payment method: ${opts.payment_method}`, 40, y); y += 24;
  doc.setFontSize(20);
  doc.text(`Amount: ${money(opts.amount, currency)}`, 40, y); y += 30;
  doc.setFontSize(10);
  if (opts.received_by) { doc.text(`Received by: ${opts.received_by}`, 40, y); y += 18; }
  if (opts.remarks) doc.text(`Remarks: ${opts.remarks}`, 40, y);

  if (action === "download") {
    doc.save(`${opts.receipt_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export function generateProductionSlipPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  production_number: string;
  production_date: string;
  product_name: string;
  quantity_produced: number;
  unit: string;
  production_cost: number;
  supervisor?: string | null;
  batch_number?: string | null;
  remarks?: string | null;
  currency?: string;
  production_type?: string | null;
  department?: string | null;
  production_scope?: string | null;
  status?: string;
  packaging_unit?: string | null;
  packaging_quantity?: number | null;
}, action: PdfAction = "download") {
  const doc = new jsPDF({ unit: "pt", format: "a5" });
  const currency = opts.currency ?? "NGN";
  doc.setFontSize(16); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, 66);
  if (opts.company.phone) doc.text(opts.company.phone, 40, 80);

  doc.setFontSize(18); doc.text("PRODUCTION SLIP", 380, 50, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.production_number}`, 380, 66, { align: "right" });
  doc.text(`Date: ${opts.production_date}`, 380, 80, { align: "right" });

  doc.setFontSize(11);
  let y = 130;
  const rows: [string, string][] = [
    ["Product", opts.product_name],
    ["Production type", opts.production_type || "—"],
    ...(opts.packaging_unit && opts.packaging_quantity != null
      ? [["Quantity produced", `${opts.packaging_quantity} ${opts.packaging_unit} (${opts.quantity_produced} ${opts.unit})`] as [string, string]]
      : [["Quantity produced", `${opts.quantity_produced} ${opts.unit}`] as [string, string]]),
    ["Production cost", money(opts.production_cost, currency)],
    ["Department", opts.department || "—"],
    ["Production scope", opts.production_scope || "—"],
    ["Status", (opts.status ?? "").replace(/_/g, " ").toUpperCase() || "—"],
    ["Supervisor", opts.supervisor || "—"],
    ["Batch number", opts.batch_number || "—"],
  ];
  rows.forEach(([l, v]) => { doc.text(`${l}: ${v}`, 40, y); y += 20; });
  if (opts.remarks) { doc.setFontSize(10); doc.text(`Remarks: ${opts.remarks}`, 40, y + 10); }

  if (action === "download") {
    doc.save(`${opts.production_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export function generateDebtStatementPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  customer: { name: string; phone?: string | null; address?: string | null };
  invoice_number?: string | null;
  products?: { name: string; quantity: number; unit_price: number; line_total: number }[];
  total_amount: number;
  amount_paid: number;
  outstanding: number;
  status: string;
  payments: { amount: number; payment_method: string; payment_date: string; received_by?: string | null }[];
  currency?: string;
}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  doc.setFontSize(18); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, 68);
  if (opts.company.phone) doc.text(opts.company.phone, 40, 82);

  doc.setFontSize(20); doc.text("DEBT STATEMENT", 555, 50, { align: "right" });
  doc.setFontSize(10);
  if (opts.invoice_number) doc.text(`Invoice: ${opts.invoice_number}`, 555, 68, { align: "right" });
  doc.text(`Status: ${opts.status.toUpperCase()}`, 555, 82, { align: "right" });

  doc.setFontSize(11); doc.text("Debtor:", 40, 110);
  doc.setFontSize(10);
  doc.text(opts.customer.name, 40, 124);
  if (opts.customer.phone) doc.text(opts.customer.phone, 40, 138);
  if (opts.customer.address) doc.text(opts.customer.address, 40, 152);

  let y = 180;
  if (opts.products && opts.products.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Product", "Qty", "Unit Price", "Total"]],
      body: opts.products.map((p) => [p.name, p.quantity.toString(), money(p.unit_price, currency), money(p.line_total, currency)]),
      styles: { fontSize: 10 },
      headStyles: { fillColor: [30, 41, 59] },
    });
    // @ts-expect-error autoTable augments doc
    y = doc.lastAutoTable.finalY + 20;
  }

  const summaryRows: [string, string][] = [
    ["Total amount", money(opts.total_amount, currency)],
    ["Amount paid", money(opts.amount_paid, currency)],
    ["Outstanding", money(opts.outstanding, currency)],
  ];
  summaryRows.forEach(([l, v], i) => {
    doc.setFont("helvetica", l === "Outstanding" ? "bold" : "normal");
    doc.text(l, 400, y + i * 16);
    doc.text(v, 555, y + i * 16, { align: "right" });
  });
  doc.setFont("helvetica", "normal");
  y += summaryRows.length * 16 + 24;

  if (opts.payments.length > 0) {
    doc.setFontSize(11); doc.text("Payment history", 40, y); y += 10;
    autoTable(doc, {
      startY: y,
      head: [["Date", "Amount", "Method", "Received by"]],
      body: opts.payments.map((p) => [p.payment_date, money(p.amount, currency), p.payment_method, p.received_by || "—"]),
      styles: { fontSize: 10 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  doc.save(`Statement-${opts.customer.name.replace(/\s+/g, "-")}.pdf`);
}

export function generateStockCardPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  title: string;
  item_name: string;
  unit: string;
  current_stock: number;
  unit_cost: number;
  total_value: number;
  reorder_level?: number | null;
  extra?: [string, string][];
  movements: { date: string; type: string; quantity: number; reference?: string | null; reason?: string | null; user?: string | null }[];
  currency?: string;
}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  doc.setFontSize(18); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, 68);
  if (opts.company.phone) doc.text(opts.company.phone, 40, 82);

  doc.setFontSize(20); doc.text(opts.title.toUpperCase(), 555, 50, { align: "right" });
  doc.setFontSize(10);
  doc.text(opts.item_name, 555, 68, { align: "right" });

  doc.setFontSize(11); doc.text("Snapshot", 40, 110);
  doc.setFontSize(10);
  const rows: [string, string][] = [
    ["Current stock", `${opts.current_stock} ${opts.unit}`],
    ["Unit cost", money(opts.unit_cost, currency)],
    ["Total value", money(opts.total_value, currency)],
    ...(opts.reorder_level != null ? [["Reorder level", `${opts.reorder_level} ${opts.unit}`] as [string, string]] : []),
    ...(opts.extra ?? []),
  ];
  let y = 124;
  rows.forEach(([l, v]) => { doc.text(`${l}: ${v}`, 40, y); y += 16; });

  y += 16;
  if (opts.movements.length > 0) {
    doc.setFontSize(11); doc.text("Stock movement history", 40, y); y += 10;
    autoTable(doc, {
      startY: y,
      head: [["Date", "Type", "Qty", "Reference", "Reason", "User"]],
      body: opts.movements.map((m) => [m.date, m.type, m.quantity.toString(), m.reference || "—", m.reason || "—", m.user || "—"]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  doc.save(`${opts.title.replace(/\s+/g, "-")}-${opts.item_name.replace(/\s+/g, "-")}.pdf`);
}

export function generateExpenseVoucherPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  expense_date: string;
  category?: string | null;
  description?: string | null;
  vendor?: string | null;
  receipt_number?: string | null;
  payment_method: string;
  amount: number;
  requested_by?: string | null;
  approval_status?: string;
  approved_by?: string | null;
  recorded_by?: string | null;
  remarks?: string | null;
  currency?: string;
}, action: PdfAction = "download") {
  const doc = new jsPDF({ unit: "pt", format: "a5" });
  const currency = opts.currency ?? "NGN";

  doc.setFontSize(16); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, 66);
  if (opts.company.phone) doc.text(opts.company.phone, 40, 80);

  doc.setFontSize(18); doc.text("EXPENSE VOUCHER", 380, 50, { align: "right" });
  doc.setFontSize(10);
  if (opts.receipt_number) doc.text(`Ref: ${opts.receipt_number}`, 380, 66, { align: "right" });
  doc.text(`Date: ${opts.expense_date}`, 380, 80, { align: "right" });

  doc.setFontSize(11);
  let y = 130;
  const rows: [string, string][] = [
    ["Category", opts.category || "—"],
    ["Description", opts.description || "—"],
    ["Vendor", opts.vendor || "—"],
    ["Payment method", opts.payment_method],
    ["Requested by", opts.requested_by || "—"],
    ["Approval status", (opts.approval_status ?? "pending").toUpperCase()],
  ];
  rows.forEach(([l, v]) => { doc.text(`${l}: ${v}`, 40, y); y += 18; });

  doc.setFontSize(20);
  y += 10; doc.text(`Amount: ${money(opts.amount, currency)}`, 40, y); y += 30;

  doc.setFontSize(10);
  if (opts.approved_by) { doc.text(`Approved by: ${opts.approved_by}`, 40, y); y += 18; }
  if (opts.recorded_by) { doc.text(`Recorded by: ${opts.recorded_by}`, 40, y); y += 18; }
  if (opts.remarks) doc.text(`Remarks: ${opts.remarks}`, 40, y);

  if (action === "download") {
    doc.save(`Expense-${opts.receipt_number || opts.expense_date}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export function generatePayslipPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  employee: { code: string | null; name: string; department?: string | null; position?: string | null; bank_name?: string | null; account_number?: string | null };
  period: string;
  payment_date?: string | null;
  payment_method?: string | null;
  basic_salary: number;
  housing_allowance: number;
  transport_allowance: number;
  meal_allowance: number;
  medical_allowance: number;
  other_allowances: number;
  overtime: number;
  gross_salary: number;
  paye: number;
  pension: number;
  loans: number;
  advance: number;
  other_deductions: number;
  net_salary: number;
  currency?: string;
}, action: PdfAction = "download") {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  doc.setFontSize(18); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, 68);
  if (opts.company.phone) doc.text(opts.company.phone, 40, 82);

  doc.setFontSize(20); doc.text("PAYSLIP", 555, 50, { align: "right" });
  doc.setFontSize(10);
  doc.text(`Period: ${opts.period}`, 555, 68, { align: "right" });
  if (opts.payment_date) doc.text(`Paid: ${opts.payment_date}`, 555, 82, { align: "right" });

  doc.setFontSize(11); doc.text("Employee", 40, 110);
  doc.setFontSize(10);
  const empRows: [string, string][] = [
    ["Employee ID", opts.employee.code || "—"],
    ["Name", opts.employee.name],
    ["Department", opts.employee.department || "—"],
    ["Position", opts.employee.position || "—"],
    ["Bank", `${opts.employee.bank_name || "—"} · ${opts.employee.account_number || "—"}`],
  ];
  let y = 126;
  empRows.forEach(([l, v]) => { doc.text(`${l}: ${v}`, 40, y); y += 15; });

  autoTable(doc, {
    startY: y + 16,
    head: [["Earnings", "Amount", "Deductions", "Amount"]],
    body: [
      ["Basic salary", money(opts.basic_salary, currency), "PAYE", money(opts.paye, currency)],
      ["Housing allowance", money(opts.housing_allowance, currency), "Pension", money(opts.pension, currency)],
      ["Transport allowance", money(opts.transport_allowance, currency), "Loans", money(opts.loans, currency)],
      ["Meal allowance", money(opts.meal_allowance, currency), "Advance", money(opts.advance, currency)],
      ["Medical allowance", money(opts.medical_allowance, currency), "Other deductions", money(opts.other_deductions, currency)],
      ["Other allowances", money(opts.other_allowances, currency), "", ""],
      ["Overtime", money(opts.overtime, currency), "", ""],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  const endY: number = doc.lastAutoTable.finalY + 20;
  doc.setFont("helvetica", "bold");
  doc.text(`Gross Salary: ${money(opts.gross_salary, currency)}`, 40, endY);
  doc.text(`Net Salary: ${money(opts.net_salary, currency)}`, 300, endY);
  doc.setFont("helvetica", "normal");
  if (opts.payment_method) doc.text(`Payment method: ${opts.payment_method}`, 40, endY + 20);

  if (action === "download") {
    doc.save(`Payslip-${opts.employee.name.replace(/\s+/g, "-")}-${opts.period}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export function generateProductionRequestPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null };
  request_number: string;
  request_date: string;
  requested_by_name: string;
  department?: string | null;
  product_name: string;
  quantity_requested: number;
  unit: string;
  approval_status: string;
  approved_by_name?: string | null;
  approval_date?: string | null;
  materials_issued: boolean;
  issued_by_name?: string | null;
  issued_at?: string | null;
  production_status: string;
  materials: { name: string; quantity_requested: number; unit: string; quantity_issued: number }[];
  remarks?: string | null;
}, action: PdfAction = "download") {
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  doc.setFontSize(18); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  let y = 68;
  if (opts.company.address) { doc.text(opts.company.address, 40, y); y += 14; }
  if (opts.company.phone) { doc.text(opts.company.phone, 40, y); y += 14; }

  doc.setFontSize(18); doc.text("PRODUCTION REQUEST / MATERIAL ISSUE", 555, 50, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.request_number}`, 555, 68, { align: "right" });
  doc.text(`Date: ${opts.request_date}`, 555, 82, { align: "right" });

  y = Math.max(y, 110);
  doc.setFontSize(11); doc.text("Request Details", 40, y); y += 16;
  doc.setFontSize(10);
  const headerRows: [string, string][] = [
    ["Requested by", opts.requested_by_name],
    ["Department", opts.department || "—"],
    ["Product to be produced", opts.product_name],
    ["Quantity requested", `${opts.quantity_requested} ${opts.unit}`],
    ["Approval status", opts.approval_status.toUpperCase()],
    ["Approved by", opts.approved_by_name || "—"],
    ["Approval date/time", opts.approval_date ? new Date(opts.approval_date).toLocaleString() : "—"],
    ["Materials issued", opts.materials_issued ? "Yes" : "No"],
    ["Issued by", opts.issued_by_name || "—"],
    ["Issued date/time", opts.issued_at ? new Date(opts.issued_at).toLocaleString() : "—"],
    ["Production status", opts.production_status.replace(/_/g, " ").toUpperCase()],
  ];
  headerRows.forEach(([l, v]) => { doc.text(`${l}:`, 40, y); doc.text(v, 220, y); y += 16; });

  y += 10;
  doc.setFontSize(11); doc.text("Raw Materials Required", 40, y); y += 8;
  autoTable(doc, {
    startY: y,
    head: [["#", "Material", "Qty Requested", "Qty Issued", "Unit"]],
    body: opts.materials.map((m, i) => [
      String(i + 1), m.name, m.quantity_requested.toString(), m.quantity_issued.toString(), m.unit,
    ]),
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  let endY: number = doc.lastAutoTable.finalY + 24;
  if (opts.remarks) { doc.setFontSize(10); doc.text(`Remarks: ${opts.remarks}`, 40, endY); endY += 24; }

  endY += 20;
  doc.setFontSize(10);
  doc.text("Requested by: ____________________", 40, endY);
  doc.text("Approved by: ____________________", 320, endY);
  endY += 40;
  doc.text("Materials issued by: ____________________", 40, endY);
  doc.text("Received by: ____________________", 320, endY);

  if (action === "download") {
    doc.save(`${opts.request_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export function generatePurchaseOrderPdf(opts: {
  company: { name: string; address?: string | null; phone?: string | null; email?: string | null };
  po_number: string;
  issued_at: string;
  issued_by_name: string;
  supplier: { name: string; phone?: string | null; address?: string | null } | null;
  material_name: string;
  quantity_ordered: number;
  quantity_received: number;
  unit: string;
  unit_cost: number | null;
  expected_delivery_date?: string | null;
  status: string;
  notes?: string | null;
  currency?: string;
}, action: PdfAction = "download") {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  doc.setFontSize(18); doc.text(opts.company.name, 40, 50);
  doc.setFontSize(10);
  let y = 68;
  if (opts.company.address) { doc.text(opts.company.address, 40, y); y += 14; }
  const contact = [opts.company.phone, opts.company.email].filter(Boolean).join(" · ");
  if (contact) { doc.text(contact, 40, y); y += 14; }

  doc.setFontSize(18); doc.text("PURCHASE ORDER", 555, 50, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.po_number}`, 555, 68, { align: "right" });
  doc.text(`Date: ${opts.issued_at}`, 555, 82, { align: "right" });
  doc.text(`Status: ${opts.status.replace(/_/g, " ").toUpperCase()}`, 555, 96, { align: "right" });

  y = Math.max(y, 120);
  doc.setFontSize(11); doc.text("Supplier", 40, y); y += 16;
  doc.setFontSize(10);
  doc.text(opts.supplier?.name ?? "—", 40, y); y += 14;
  if (opts.supplier?.phone) { doc.text(opts.supplier.phone, 40, y); y += 14; }
  if (opts.supplier?.address) { doc.text(opts.supplier.address, 40, y); y += 14; }

  y += 16;
  doc.setFontSize(11); doc.text("Order Details", 40, y); y += 8;
  autoTable(doc, {
    startY: y,
    head: [["Material", "Qty Ordered", "Qty Received", "Unit", "Unit Cost", "Line Total"]],
    body: [[
      opts.material_name,
      opts.quantity_ordered.toString(),
      opts.quantity_received.toString(),
      opts.unit,
      opts.unit_cost != null ? pdfMoney(opts.unit_cost, currency) : "—",
      opts.unit_cost != null ? pdfMoney(opts.unit_cost * opts.quantity_ordered, currency) : "—",
    ]],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  let endY: number = doc.lastAutoTable.finalY + 20;
  doc.setFontSize(10);
  doc.text(`Expected delivery: ${opts.expected_delivery_date ?? "—"}`, 40, endY); endY += 16;
  doc.text(`Issued by: ${opts.issued_by_name}`, 40, endY); endY += 16;
  if (opts.notes) { doc.text(`Notes: ${opts.notes}`, 40, endY); endY += 16; }

  endY += 30;
  doc.text("Authorized by: ____________________", 40, endY);
  doc.text("Supplier acknowledgement: ____________________", 320, endY);

  if (action === "download") {
    doc.save(`${opts.po_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export function generateReportPdf(
  title: string,
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: columns.length > 6 ? "landscape" : "portrait" });
  doc.setFontSize(16); doc.text(title, 40, 40);
  doc.setFontSize(9); doc.text(`Generated ${new Date().toLocaleString()}`, 40, 56);

  autoTable(doc, {
    startY: 72,
    head: [columns.map((c) => c.label)],
    body: rows.map((r) => columns.map((c) => (r[c.key] == null ? "—" : String(r[c.key])))),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  if (action === "download") {
    doc.save(`${title.replace(/\s+/g, "-")}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
