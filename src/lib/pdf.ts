import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { money } from "./format";
import { PARTY_KINDS, sheetDayLabel, sheetTotals } from "./marketer-sales-sheet";

export type InvoiceItem = {
  name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
};

export type InvoiceData = {
  company: {
    name: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    logo_url?: string | null;
  };
  invoice_number: string;
  sale_date: string;
  // When it was recorded (date and time on the slim receipt); now if absent.
  issued_at?: string | null;
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
  is_pr?: boolean;
};

export type PdfAction = "download" | "print" | "preview";

// Bundled brand logo (public/assets/), served same-origin so it never taints
// the canvas. Used on every receipt/print when a factory hasn't uploaded its
// own logo in Settings, so nothing prints logo-less.
const FALLBACK_LOGO_URL = "/assets/elim-logo.png";

// jsPDF's built-in fonts have no glyph for the Naira sign (₦) -- it prints as
// a broken box on thermal/receipt output. Use a plain currency-code prefix
// for PDFs instead of the on-screen Intl currency symbol from format.ts.
export const pdfMoney = (n: number, currency: string) => {
  const v = typeof n === "number" ? n : 0;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(v));
  return `${v < 0 ? "-" : ""}${currency} ${formatted}`;
};

// Decodes the logo into a same-origin canvas so it can be embedded via
// addImage regardless of source format (png/jpg/webp all normalize to PNG).
// Resolves to null on any failure (missing logo, CORS, bad URL) so a broken
// logo never blocks printing a sale.
async function loadLogo(
  url: string,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
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
    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  } catch {
    return null;
  }
}

// Loads the factory's uploaded logo, falling back to the bundled brand logo
// when there's no custom one (or it fails to load). Returns null only if even
// the fallback can't be decoded, so a genuinely broken logo never blocks a
// print.
export async function resolveLogo(
  url: string | null | undefined,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (url) {
    const custom = await loadLogo(url);
    if (custom) return custom;
  }
  return loadLogo(FALLBACK_LOGO_URL);
}

// Draws the company logo centered at the top of the page (any format/orientation)
// and returns the y-coordinate the rest of the header should start from --
// `baseTop` unchanged when there's no logo, pushed down by the logo's height
// (capped to maxW x maxH) plus a gap when there is one.
export async function drawLogoHeader(
  doc: jsPDF,
  logoUrl: string | null | undefined,
  baseTop: number,
  maxW = 90,
  maxH = 34,
): Promise<number> {
  const logo = await resolveLogo(logoUrl);
  if (!logo) return baseTop;
  const ratio = Math.min(maxW / logo.width, maxH / logo.height, 1);
  const w = logo.width * ratio,
    h = logo.height * ratio;
  const pageW = doc.internal.pageSize.getWidth();
  doc.addImage(logo.dataUrl, "PNG", pageW / 2 - w / 2, 14, w, h);
  return baseTop + h + 10;
}

// The Warehouse's slim POS roll: exactly 80mm wide, as long as the receipt
// (a fixed 297mm page fed ~20cm of blank roll after every receipt). The
// margins keep text inside the roll's 72mm printable width, so the printer
// has nothing to shrink.
const ROLL_W = 226.77; // 80mm in pt
const ROLL_M = 14;

// The Warehouse's slim receipt, laid out like the factory's own "LOAD ORDER
// RECEIPT" (user's sample, 2026-10-29): logo, address and phone centred; the
// long date left and the time right; the title; Trans. ID / Sales Rep. /
// Marketer/Dist. side by side; "Transaction Details" with Item, Qty,
// Price(N), Amount(N); Subtotal, Surcharge, Discount, Amount to pay; thanks.
// Typewriter (Courier) type sized for the 72mm printable width. No QR code.
export type RollReceipt = {
  company: {
    address?: string | null;
    phone?: string | null;
    logo_url?: string | null;
    name?: string;
  };
  title: string;
  at: Date;
  trans_id: string;
  sales_rep?: string | null;
  party_label: string;
  party: string;
  items: { name: string; quantity: number; unit_price: number; amount: number }[];
  subtotal: number;
  surcharge: number;
  discount: number;
  total: number;
  // Extra lines under the totals, e.g. "Amount paid", "Balance".
  extra?: [string, number][];
  note?: string | null;
  file_name: string;
};

export async function generateRollReceiptPdf(
  r: RollReceipt,
  action: PdfAction = "print",
  copies = 1,
) {
  // Printing goes straight to the printer as a plain page (dark, uncut,
  // every copy the same); the PDF below is for download / preview.
  if (action === "print") {
    const { printRollReceipt } = await import("@/lib/roll-receipt-print");
    await printRollReceipt(r, copies);
    return;
  }
  const logo = await resolveLogo(r.company.logo_url);
  const W = ROLL_W;
  const M = ROLL_M;
  const right = W - M;
  const contentW = W - M * 2;
  const center = W / 2;
  const amt = (n: number) => Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const naira = (n: number) => `N${amt(n)}`;
  const day = r.at.getDate();
  const nth =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  const dateText = `${r.at.toLocaleDateString("en-GB", { weekday: "long" })} ${day}${nth} ${r.at.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}`;
  const timeText = r.at.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const draw = (doc: jsPDF): number => {
    let y = M;
    const font = (size: number, bold = false) => {
      doc.setFont("courier", bold ? "bold" : "normal");
      doc.setFontSize(size);
    };
    const centred = (text: string, size: number, bold = false) => {
      font(size, bold);
      (doc.splitTextToSize(text, contentW) as string[]).forEach((ln) => {
        doc.text(ln, center, y, { align: "center" });
        y += size + 2;
      });
    };

    if (logo) {
      const ratio = Math.min(130 / logo.width, 48 / logo.height, 1);
      const w = logo.width * ratio;
      const h = logo.height * ratio;
      doc.addImage(logo.dataUrl, "PNG", center - w / 2, y, w, h);
      y += h + 8;
    } else if (r.company.name) {
      centred(r.company.name, 11, true);
    }
    if (r.company.address) centred(r.company.address, 7);
    if (r.company.phone) centred(r.company.phone, 7);
    y += 8;

    // Date left, time right.
    font(7.5);
    doc.text(dateText, M, y);
    doc.text(timeText, right, y, { align: "right" });
    y += 18;

    centred(r.title, 12, true);
    y += 4;

    // Trans. ID / Sales Rep. / Marketer/Dist., side by side.
    const cols = [
      { x: M, w: 78, label: "Trans. ID:", value: r.trans_id },
      { x: M + 80, w: 56, label: "Sales Rep.:", value: r.sales_rep || "—" },
      { x: M + 138, w: contentW - 138, label: `${r.party_label}:`, value: r.party },
    ];
    font(6.5);
    cols.forEach((c) => doc.text(c.label, c.x, y));
    y += 9;
    const values = cols.map((c) => doc.splitTextToSize(c.value, c.w) as string[]);
    values.forEach((lines, i) => lines.forEach((ln, j) => doc.text(ln, cols[i].x, y + j * 8)));
    y += Math.max(...values.map((v) => v.length)) * 8 + 10;

    font(7.5);
    doc.text("Transaction Details", M, y);
    y += 14;

    // Item | Qty | Price(N) | Amount(N)
    const qtyX = M + 112;
    const priceX = M + 152;
    font(7, true);
    doc.text("Item", M, y);
    doc.text("Qty", qtyX, y, { align: "right" });
    doc.text("Price(N)", priceX, y, { align: "right" });
    doc.text("Amount(N)", right, y, { align: "right" });
    y += 3;
    doc.line(M, y, right, y);
    y += 10;
    font(7);
    for (const it of r.items) {
      // Room left for a quantity up to "14,424" before the Qty column.
      const name = doc.splitTextToSize(it.name, qtyX - M - 30) as string[];
      doc.text(String(it.quantity.toLocaleString("en-US")), qtyX, y, { align: "right" });
      doc.text(amt(it.unit_price), priceX, y, { align: "right" });
      doc.text(amt(it.amount), right, y, { align: "right" });
      name.forEach((ln, j) => doc.text(ln, M, y + j * 9));
      y += name.length * 9 + 3;
    }
    y += 2;
    doc.setLineDashPattern([2, 1], 0);
    doc.line(M, y, right, y);
    doc.setLineDashPattern([], 0);
    y += 11;

    const total = (label: string, value: string, bold = false) => {
      font(7.5, bold);
      doc.text(label, M, y);
      doc.text(value, right, y, { align: "right" });
      y += 11;
    };
    total("Subtotal", naira(r.subtotal));
    total("Surcharge", naira(r.surcharge));
    total("Discount", naira(r.discount));
    total("Amount to pay", naira(r.total), true);
    for (const [label, value] of r.extra ?? []) total(label, naira(value));
    if (r.note) {
      y += 2;
      font(6.5);
      (doc.splitTextToSize(r.note, contentW) as string[]).forEach((ln) => {
        doc.text(ln, M, y);
        y += 8;
      });
    }
    y += 10;
    centred("Thank you for your patronage!", 8, true);
    return y;
  };

  const scratch = new jsPDF({ unit: "pt", format: [W, 4000] });
  const finalY = draw(scratch);
  const doc = new jsPDF({ unit: "pt", format: [W, finalY + M] });
  draw(doc);
  // Copies are identical pages of the same size in one document, printed as
  // one copy: each comes out exactly like a single print (the print dialog's
  // own copies count shrank them).
  for (let i = 1; i < Math.max(1, Math.floor(copies)); i++) {
    doc.addPage([W, finalY + M]);
    draw(doc);
  }
  if (action === "download") doc.save(`${r.file_name}.pdf`);
  else window.open(doc.output("bloburl"), "_blank");
}

// A4 page by default (printed on a standard office printer) so the receipt
// fills the printout instead of appearing tiny in a corner. paper "roll"
// prints the Warehouse's slim receipt instead (generateRollReceiptPdf).
export async function generateInvoicePdf(
  data: InvoiceData,
  action: PdfAction = "download",
  paper: "a4" | "roll" = "a4",
  // Slim receipt only: identical pages in one print (generateRollReceiptPdf).
  copies = 1,
) {
  if (paper === "roll") {
    const paid = Number(data.amount_paid ?? 0);
    await generateRollReceiptPdf(
      {
        company: data.company,
        title: data.is_pr ? "PR - NO CHARGE" : "LOAD ORDER RECEIPT",
        at: data.issued_at ? new Date(data.issued_at) : new Date(),
        trans_id: data.invoice_number,
        sales_rep: data.sales_person,
        party_label: "Marketer/Dist.",
        party: data.customer.name || "Walk-in",
        items: data.items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unit_price: it.unit_price,
          amount: it.line_total,
        })),
        subtotal: data.subtotal,
        surcharge: data.vat,
        discount: data.discount,
        total: data.grand_total,
        extra:
          paid > 0 && !data.is_pr
            ? [
                ["Amount paid", paid],
                ["Balance", data.balance],
              ]
            : undefined,
        file_name: data.invoice_number,
      },
      action,
      copies,
    );
    return;
  }
  const currency = data.currency ?? "NGN";
  const cur = (n: number) => pdfMoney(n, currency);
  const logo = await resolveLogo(data.company.logo_url);
  const W = 595; // A4 width in pt
  const M = 40;
  const contentW = W - M * 2;
  const center = W / 2;
  const fz = (n: number) => n;

  const draw = (doc: jsPDF): number => {
    let y = M;
    const centred = (text: string, gap: number) => {
      (doc.splitTextToSize(text, contentW) as string[]).forEach((ln) => {
        doc.text(ln, center, y, { align: "center" });
        y += fz(gap);
      });
    };
    const left = (text: string, gap: number) => {
      (doc.splitTextToSize(text, contentW) as string[]).forEach((ln) => {
        doc.text(ln, M, y);
        y += fz(gap);
      });
    };

    if (logo) {
      const maxW = 90,
        maxH = 50;
      const ratio = Math.min(maxW / logo.width, maxH / logo.height, 1);
      const w = logo.width * ratio,
        h = logo.height * ratio;
      doc.addImage(logo.dataUrl, "PNG", center - w / 2, y, w, h);
      y += h + 8;
    }

    // The logo already names the company; the name line is only a fallback
    // for when there is no logo to show.
    if (!logo) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(fz(12));
      centred(data.company.name || "Company", 14);
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(fz(8));
    if (data.company.address) centred(data.company.address, 11);
    const contact = [data.company.phone, data.company.email].filter(Boolean).join(" · ");
    if (contact) centred(contact, 11);

    y += 4;
    doc.setLineDashPattern([2, 1], 0);
    doc.line(M, y, W - M, y);
    y += fz(12);
    doc.setLineDashPattern([], 0);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(fz(10));
    centred(data.is_pr ? "PR — COMPLIMENTARY (NO CHARGE)" : "SALES RECEIPT", 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(fz(8));
    left(`Invoice: ${data.invoice_number}`, 11);
    left(`Date: ${data.sale_date}`, 11);

    doc.line(M, y, W - M, y);
    y += fz(12);

    left(`Customer: ${data.customer.name || "Walk-in"}`, 11);
    if (data.customer.phone) left(`Phone: ${data.customer.phone}`, 11);

    doc.line(M, y, W - M, y);
    y += fz(12);

    data.items.forEach((it) => {
      doc.setFont("helvetica", "normal");
      left(it.name, 10);
      const qty = `${it.quantity} ${it.unit} x ${cur(it.unit_price)}`;
      const value = cur(it.line_total);
      doc.text(qty, M, y);
      // Too long for one line: the value goes under it.
      if (doc.getTextWidth(qty) + doc.getTextWidth(value) + 8 > contentW) y += fz(11);
      doc.text(value, W - M, y, { align: "right" });
      y += fz(12);
    });

    doc.line(M, y, W - M, y);
    y += fz(12);

    const row = (label: string, value: string, bold = false, size = 8) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(fz(size));
      doc.text(label, M, y);
      if (doc.getTextWidth(label) + doc.getTextWidth(value) + 8 > contentW) y += fz(size + 3);
      doc.text(value, W - M, y, { align: "right" });
      y += fz(bold ? 16 : 12);
    };
    if (data.is_pr) {
      row("Value of goods issued", cur(data.subtotal));
      row("NOT BILLED — no payment due", "N/A", true, 10);
    } else {
      row("Subtotal", cur(data.subtotal));
      if (data.discount > 0) row("Discount", `-${cur(data.discount)}`);
      if (data.vat > 0) row("VAT", cur(data.vat));
      row("GRAND TOTAL", cur(data.grand_total), true, 10);
      row("Amount Paid", cur(data.amount_paid));
      row("Balance Due", cur(data.balance), data.balance > 0);
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(fz(8));
    doc.line(M, y, W - M, y);
    y += fz(12);

    if (data.sales_person) left(`Sales person: ${data.sales_person}`, 11);
    if (data.remarks) left(`Remarks: ${data.remarks}`, 10);

    y += 6;
    doc.setFont("helvetica", "bold");
    centred("Thank you for your patronage!", 14);

    return y;
  };

  const A4_H = 842; // A4 height in pt
  const scratch = new jsPDF({ unit: "pt", format: [W, 4000] });
  const finalY = draw(scratch);

  // Fill a full A4 page — only grow taller for an unusually long cart that
  // wouldn't fit, rather than ever clipping content.
  const doc = new jsPDF({
    unit: "pt",
    format: [W, Math.max(A4_H, finalY + M)],
  });
  draw(doc);

  if (action === "download") {
    doc.save(`${data.invoice_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export async function generateReceiptPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    receipt_number: string;
    payment_date: string;
    customer_name?: string | null;
    invoice_number?: string | null;
    amount: number;
    payment_method: string;
    // Present when the payment was split across more than one method — one
    // receipt still covers the whole transaction, listing each method's
    // share instead of a single "Payment method: X" line.
    breakdown?: { method: string; amount: number }[];
    received_by?: string | null;
    remarks?: string | null;
    currency?: string;
  },
  action: PdfAction = "download",
) {
  // A4 (standard office printer paper) so the receipt fills the printout.
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";
  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 16);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 30);

  doc.setFontSize(18);
  doc.text("RECEIPT", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.receipt_number}`, 555, top + 16, { align: "right" });
  doc.text(`Date: ${opts.payment_date}`, 555, top + 30, { align: "right" });

  doc.setFontSize(11);
  let y = top + 80;
  doc.text(`Received from: ${opts.customer_name ?? "—"}`, 40, y);
  y += 18;
  if (opts.invoice_number) {
    doc.text(`Invoice: ${opts.invoice_number}`, 40, y);
    y += 18;
  }
  if (opts.breakdown && opts.breakdown.length > 1) {
    for (const line of opts.breakdown) {
      doc.text(`${line.method}: ${money(line.amount, currency)}`, 40, y);
      y += 16;
    }
    y += 8;
  } else {
    doc.text(`Payment method: ${opts.payment_method}`, 40, y);
    y += 24;
  }
  doc.setFontSize(20);
  doc.text(`Amount: ${money(opts.amount, currency)}`, 40, y);
  y += 30;
  doc.setFontSize(10);
  if (opts.received_by) {
    doc.text(`Received by: ${opts.received_by}`, 40, y);
    y += 18;
  }
  if (opts.remarks) doc.text(`Remarks: ${opts.remarks}`, 40, y);

  if (action === "download") {
    doc.save(`${opts.receipt_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export async function generateProductionSlipPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
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
    accepted_quantity?: number | null;
    damaged_quantity?: number | null;
    rejected_quantity?: number | null;
    confirmed_at?: string | null;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a5" });
  const currency = opts.currency ?? "NGN";
  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 16);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 30);

  doc.setFontSize(18);
  doc.text("PRODUCTION REPORT", 380, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.production_number}`, 380, top + 16, { align: "right" });
  doc.text(`Date: ${opts.production_date}`, 380, top + 30, { align: "right" });

  doc.setFontSize(11);
  let y = top + 80;
  const rows: [string, string][] = [
    ["Product", opts.product_name],
    ["Production type", opts.production_type || "—"],
    ...(opts.packaging_unit && opts.packaging_quantity != null
      ? [
          [
            "Quantity produced",
            `${opts.packaging_quantity} ${opts.packaging_unit} (${opts.quantity_produced} ${opts.unit})`,
          ] as [string, string],
        ]
      : [["Quantity produced", `${opts.quantity_produced} ${opts.unit}`] as [string, string]]),
    ["Department", opts.department || "—"],
    ["Production scope", opts.production_scope || "—"],
    ["Status / Approval", (opts.status ?? "").replace(/_/g, " ").toUpperCase() || "—"],
    ["User", opts.supervisor || "—"],
    ["Batch number", opts.batch_number || "—"],
  ];
  rows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 20;
  });
  if (opts.remarks) {
    doc.setFontSize(10);
    doc.text(`Remarks: ${opts.remarks}`, 40, y + 10);
    y += 20;
  }

  // Warehouse acceptance — only present once the Warehouse has actually acted on this batch.
  if (opts.confirmed_at) {
    y += 12;
    doc.setFontSize(11);
    doc.text("Warehouse Acceptance", 40, y);
    y += 16;
    doc.setFontSize(10);
    const confRows: [string, string][] = [
      ["Accepted on", new Date(opts.confirmed_at).toLocaleString()],
      ["Accepted", opts.accepted_quantity != null ? `${opts.accepted_quantity} ${opts.unit}` : "—"],
      ["Damaged", opts.damaged_quantity ? `${opts.damaged_quantity} ${opts.unit}` : "—"],
      ["Rejected", opts.rejected_quantity ? `${opts.rejected_quantity} ${opts.unit}` : "—"],
    ];
    confRows.forEach(([l, v]) => {
      doc.text(`${l}: ${v}`, 40, y);
      y += 18;
    });
  }

  y += 24;
  doc.setFontSize(9);
  doc.line(40, y, 200, y);
  doc.line(260, y, 420, y);
  y += 12;
  doc.text("Prepared by / Date", 40, y);
  doc.text("Warehouse Accepted by / Date", 260, y);

  if (action === "download") {
    doc.save(`${opts.production_number}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export async function generateDebtStatementPdf(opts: {
  company: {
    name: string;
    address?: string | null;
    phone?: string | null;
    logo_url?: string | null;
  };
  customer: { name: string; phone?: string | null; address?: string | null };
  invoice_number?: string | null;
  products?: { name: string; quantity: number; unit_price: number; line_total: number }[];
  total_amount: number;
  amount_paid: number;
  outstanding: number;
  status: string;
  payments: {
    amount: number;
    payment_method: string;
    payment_date: string;
    received_by?: string | null;
  }[];
  currency?: string;
}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 18);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 32);

  doc.setFontSize(20);
  doc.text("DEBT STATEMENT", 555, top, { align: "right" });
  doc.setFontSize(10);
  if (opts.invoice_number)
    doc.text(`Invoice: ${opts.invoice_number}`, 555, top + 18, { align: "right" });
  doc.text(`Status: ${opts.status.toUpperCase()}`, 555, top + 32, { align: "right" });

  doc.setFontSize(11);
  doc.text("Debtor:", 40, top + 60);
  doc.setFontSize(10);
  doc.text(opts.customer.name, 40, top + 74);
  if (opts.customer.phone) doc.text(opts.customer.phone, 40, top + 88);
  if (opts.customer.address) doc.text(opts.customer.address, 40, top + 102);

  let y = top + 130;
  if (opts.products && opts.products.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Product", "Qty", "Unit Price", "Total"]],
      body: opts.products.map((p) => [
        p.name,
        p.quantity.toString(),
        money(p.unit_price, currency),
        money(p.line_total, currency),
      ]),
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
    doc.setFontSize(11);
    doc.text("Payment history", 40, y);
    y += 10;
    autoTable(doc, {
      startY: y,
      head: [["Date", "Amount", "Method", "Received by"]],
      body: opts.payments.map((p) => [
        p.payment_date,
        money(p.amount, currency),
        p.payment_method,
        p.received_by || "—",
      ]),
      styles: { fontSize: 10 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  doc.save(`Statement-${opts.customer.name.replace(/\s+/g, "-")}.pdf`);
}

export async function generateStockCardPdf(opts: {
  company: {
    name: string;
    address?: string | null;
    phone?: string | null;
    logo_url?: string | null;
  };
  title: string;
  item_name: string;
  unit: string;
  current_stock: number;
  unit_cost: number;
  total_value: number;
  reorder_level?: number | null;
  extra?: [string, string][];
  movements: {
    date: string;
    type: string;
    quantity: number;
    reference?: string | null;
    reason?: string | null;
    user?: string | null;
  }[];
  currency?: string;
}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 18);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 32);

  doc.setFontSize(20);
  doc.text(opts.title.toUpperCase(), 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(opts.item_name, 555, top + 18, { align: "right" });

  doc.setFontSize(11);
  doc.text("Snapshot", 40, top + 60);
  doc.setFontSize(10);
  const rows: [string, string][] = [
    ["Current stock", `${opts.current_stock} ${opts.unit}`],
    ["Unit cost", money(opts.unit_cost, currency)],
    ["Total value", money(opts.total_value, currency)],
    ...(opts.reorder_level != null
      ? [["Reorder level", `${opts.reorder_level} ${opts.unit}`] as [string, string]]
      : []),
    ...(opts.extra ?? []),
  ];
  let y = top + 74;
  rows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 16;
  });

  y += 16;
  if (opts.movements.length > 0) {
    doc.setFontSize(11);
    doc.text("Stock movement history", 40, y);
    y += 10;
    autoTable(doc, {
      startY: y,
      head: [["Date", "Type", "Qty", "Reference", "Reason", "User"]],
      body: opts.movements.map((m) => [
        m.date,
        m.type,
        m.quantity.toString(),
        m.reference || "—",
        m.reason || "—",
        m.user || "—",
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  doc.save(`${opts.title.replace(/\s+/g, "-")}-${opts.item_name.replace(/\s+/g, "-")}.pdf`);
}

export async function generateExpenseVoucherPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
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
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a5" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 16);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 30);

  doc.setFontSize(18);
  doc.text("EXPENSE VOUCHER", 380, top, { align: "right" });
  doc.setFontSize(10);
  if (opts.receipt_number)
    doc.text(`Ref: ${opts.receipt_number}`, 380, top + 16, { align: "right" });
  doc.text(`Date: ${opts.expense_date}`, 380, top + 30, { align: "right" });

  doc.setFontSize(11);
  let y = top + 80;
  const rows: [string, string][] = [
    ["Category", opts.category || "—"],
    ["Description", opts.description || "—"],
    ["Vendor", opts.vendor || "—"],
    ["Payment method", opts.payment_method],
    ["Requested by", opts.requested_by || "—"],
    ["Approval status", (opts.approval_status ?? "pending").toUpperCase()],
  ];
  rows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 18;
  });

  doc.setFontSize(20);
  y += 10;
  doc.text(`Amount: ${money(opts.amount, currency)}`, 40, y);
  y += 30;

  doc.setFontSize(10);
  if (opts.approved_by) {
    doc.text(`Approved by: ${opts.approved_by}`, 40, y);
    y += 18;
  }
  if (opts.recorded_by) {
    doc.text(`Recorded by: ${opts.recorded_by}`, 40, y);
    y += 18;
  }
  if (opts.remarks) doc.text(`Remarks: ${opts.remarks}`, 40, y);

  if (action === "download") {
    doc.save(`Expense-${opts.receipt_number || opts.expense_date}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export async function generatePayslipPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    employee: {
      code: string | null;
      name: string;
      department?: string | null;
      position?: string | null;
      bank_name?: string | null;
      account_number?: string | null;
    };
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
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 18);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 32);

  doc.setFontSize(20);
  doc.text("PAYSLIP", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`Period: ${opts.period}`, 555, top + 18, { align: "right" });
  if (opts.payment_date) doc.text(`Paid: ${opts.payment_date}`, 555, top + 32, { align: "right" });

  doc.setFontSize(11);
  doc.text("Employee", 40, top + 60);
  doc.setFontSize(10);
  const empRows: [string, string][] = [
    ["Employee ID", opts.employee.code || "—"],
    ["Name", opts.employee.name],
    ["Department", opts.employee.department || "—"],
    ["Position", opts.employee.position || "—"],
    ["Bank", `${opts.employee.bank_name || "—"} · ${opts.employee.account_number || "—"}`],
  ];
  let y = top + 76;
  empRows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 15;
  });

  autoTable(doc, {
    startY: y + 16,
    head: [["Earnings", "Amount", "Deductions", "Amount"]],
    body: [
      ["Basic salary", money(opts.basic_salary, currency), "PAYE", money(opts.paye, currency)],
      [
        "Housing allowance",
        money(opts.housing_allowance, currency),
        "Pension",
        money(opts.pension, currency),
      ],
      [
        "Transport allowance",
        money(opts.transport_allowance, currency),
        "Loans",
        money(opts.loans, currency),
      ],
      [
        "Meal allowance",
        money(opts.meal_allowance, currency),
        "Advance",
        money(opts.advance, currency),
      ],
      [
        "Medical allowance",
        money(opts.medical_allowance, currency),
        "Other deductions",
        money(opts.other_deductions, currency),
      ],
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

export async function generateProductionRequestPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
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
    materials: {
      name: string;
      quantity_requested: number;
      unit: string;
      quantity_issued: number;
    }[];
    remarks?: string | null;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  let y = top + 18;
  if (opts.company.address) {
    doc.text(opts.company.address, 40, y);
    y += 14;
  }
  if (opts.company.phone) {
    doc.text(opts.company.phone, 40, y);
    y += 14;
  }

  doc.setFontSize(18);
  doc.text("PRODUCTION REQUEST / MATERIAL ISSUE", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.request_number}`, 555, top + 18, { align: "right" });
  doc.text(`Date: ${opts.request_date}`, 555, top + 32, { align: "right" });

  y = Math.max(y, top + 60);
  doc.setFontSize(11);
  doc.text("Request Details", 40, y);
  y += 16;
  doc.setFontSize(10);
  const headerRows: [string, string][] = [
    ["Requested by", opts.requested_by_name],
    ["Department", opts.department || "—"],
    ["Product to be produced", opts.product_name],
    ["Quantity requested", `${opts.quantity_requested} ${opts.unit}`],
    ["Approval status", opts.approval_status.toUpperCase()],
    ["Approved by", opts.approved_by_name || "—"],
    [
      "Approval date/time",
      opts.approval_date ? new Date(opts.approval_date).toLocaleString() : "—",
    ],
    ["Materials issued", opts.materials_issued ? "Yes" : "No"],
    ["Issued by", opts.issued_by_name || "—"],
    ["Issued date/time", opts.issued_at ? new Date(opts.issued_at).toLocaleString() : "—"],
    ["Production status", opts.production_status.replace(/_/g, " ").toUpperCase()],
  ];
  headerRows.forEach(([l, v]) => {
    doc.text(`${l}:`, 40, y);
    doc.text(v, 220, y);
    y += 16;
  });

  y += 10;
  doc.setFontSize(11);
  doc.text("Raw Materials Required", 40, y);
  y += 8;
  autoTable(doc, {
    startY: y,
    head: [["#", "Material", "Qty Requested", "Qty Issued", "Unit"]],
    body: opts.materials.map((m, i) => [
      String(i + 1),
      m.name,
      m.quantity_requested.toString(),
      m.quantity_issued.toString(),
      m.unit,
    ]),
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  let endY: number = doc.lastAutoTable.finalY + 24;
  if (opts.remarks) {
    doc.setFontSize(10);
    doc.text(`Remarks: ${opts.remarks}`, 40, endY);
    endY += 24;
  }

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

// A posting from the Warehouse to a marketer or the Company Retail Shop
// (stock_dispatches), printed as the Warehouse's slim LOAD ORDER RECEIPT
// (generateRollReceiptPdf), like a posting to a distributor.
export async function generateDispatchSlipPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      logo_url?: string | null;
    };
    dispatch_number: string;
    dispatch_date: string;
    // When it was recorded (time on the receipt); the dispatch date if absent.
    created_at?: string | null;
    holder: { name: string; code?: string | null; kind?: string | null };
    status: string;
    items: {
      name: string;
      quantity: number;
      unit: string;
      unit_price: number;
      line_value: number;
    }[];
    total_value: number;
    notes?: string | null;
    posted_by?: string | null;
    currency?: string;
  },
  action: PdfAction = "download",
  copies = 1,
) {
  await generateRollReceiptPdf(
    {
      company: opts.company,
      title: "LOAD ORDER RECEIPT",
      at: new Date(opts.created_at ?? `${opts.dispatch_date}T12:00:00`),
      trans_id: opts.dispatch_number,
      sales_rep: opts.posted_by,
      party_label: opts.holder.kind === "outlet" ? "Retail Shop" : "Marketer/Dist.",
      party: opts.holder.name + (opts.holder.code ? ` (${opts.holder.code})` : ""),
      items: opts.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unit_price: it.unit_price,
        amount: it.line_value,
      })),
      subtotal: opts.total_value,
      surcharge: 0,
      discount: 0,
      total: opts.total_value,
      note:
        opts.status === "posted" ? null : `Status: ${opts.status.replace(/_/g, " ").toUpperCase()}`,
      file_name: opts.dispatch_number,
    },
    action,
    copies,
  );
}

export type WarehouseReportRow = {
  product_name: string;
  opening: number;
  qty_in: number;
  qty_out: number;
  gift: number;
  returned: number;
  sold: number;
  empty_jug_sold: number;
  balance: number;
};

// "WAREHOUSE: PRODUCTS REPORT FROM .. TO .." in the factory's own layout:
// letterhead centred at the top (logo, address, phone / email, website),
// then one row per product (warehouse_products_report).
export async function generateWarehouseProductsReportPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      website?: string | null;
      logo_url?: string | null;
    };
    from: string;
    to: string;
    rows: WarehouseReportRow[];
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const W = doc.internal.pageSize.getWidth();
  const center = W / 2;
  const logo = await resolveLogo(opts.company.logo_url);

  let y = 24;
  if (logo) {
    const ratio = Math.min(150 / logo.width, 70 / logo.height, 1);
    const w = logo.width * ratio;
    const h = logo.height * ratio;
    doc.addImage(logo.dataUrl, "PNG", center - w / 2, y, w, h);
    y += h + 14;
  } else {
    doc.setFont("times", "bold");
    doc.setFontSize(16);
    doc.text(opts.company.name, center, y + 10, { align: "center" });
    y += 26;
  }
  doc.setFont("times", "bold");
  doc.setFontSize(10);
  const lines = [
    opts.company.address,
    [
      opts.company.phone && `Tel: ${opts.company.phone}`,
      opts.company.email && `Email: ${opts.company.email}`,
    ]
      .filter(Boolean)
      .join(", "),
    opts.company.website && `Website: ${opts.company.website}`,
  ].filter(Boolean) as string[];
  lines.forEach((ln) => {
    (doc.splitTextToSize(ln, W - 80) as string[]).forEach((part) => {
      doc.text(part, center, y, { align: "center" });
      y += 13;
    });
  });

  y += 16;
  doc.setFontSize(12);
  doc.text(`WAREHOUSE: PRODUCTS REPORT FROM ${opts.from} TO ${opts.to}`, center, y, {
    align: "center",
  });
  y += 12;

  const n = (v: number) => (v ? v.toLocaleString() : "0");
  autoTable(doc, {
    startY: y,
    margin: { left: 30, right: 30 },
    head: [
      [
        "S/N",
        "Product",
        "Opening",
        "Quantity In",
        "Total",
        "Quantity Out",
        "Gift/Sample",
        "Quantity Returned",
        "Quantity Sold",
        "Empty Jug Sold",
        "Balance",
      ],
    ],
    body: opts.rows.map((r, i) => [
      String(i + 1),
      r.product_name,
      n(r.opening),
      n(r.qty_in),
      n(r.opening + r.qty_in),
      n(r.qty_out),
      n(r.gift),
      n(r.returned),
      n(r.sold),
      r.empty_jug_sold ? r.empty_jug_sold.toLocaleString() : "",
      n(r.balance),
    ]),
    theme: "grid",
    styles: {
      font: "times",
      fontStyle: "bold",
      fontSize: 10,
      textColor: [0, 0, 0],
      lineColor: [0, 0, 0],
      lineWidth: 0.6,
      cellPadding: 3,
    },
    headStyles: { fillColor: [31, 119, 180], textColor: [255, 255, 255], fontSize: 11 },
  });

  const name = `warehouse-products-report-${opts.from}-to-${opts.to}`;
  if (action === "download") {
    doc.save(`${name}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

export async function generatePurchaseOrderPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      logo_url?: string | null;
    };
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
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  let y = top + 18;
  if (opts.company.address) {
    doc.text(opts.company.address, 40, y);
    y += 14;
  }
  const contact = [opts.company.phone, opts.company.email].filter(Boolean).join(" · ");
  if (contact) {
    doc.text(contact, 40, y);
    y += 14;
  }

  doc.setFontSize(18);
  doc.text("PURCHASE ORDER", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.po_number}`, 555, top + 18, { align: "right" });
  doc.text(`Date: ${opts.issued_at}`, 555, top + 32, { align: "right" });
  doc.text(`Status: ${opts.status.replace(/_/g, " ").toUpperCase()}`, 555, top + 46, {
    align: "right",
  });

  y = Math.max(y, top + 70);
  doc.setFontSize(11);
  doc.text("Supplier", 40, y);
  y += 16;
  doc.setFontSize(10);
  doc.text(opts.supplier?.name ?? "—", 40, y);
  y += 14;
  if (opts.supplier?.phone) {
    doc.text(opts.supplier.phone, 40, y);
    y += 14;
  }
  if (opts.supplier?.address) {
    doc.text(opts.supplier.address, 40, y);
    y += 14;
  }

  y += 16;
  doc.setFontSize(11);
  doc.text("Order Details", 40, y);
  y += 8;
  autoTable(doc, {
    startY: y,
    head: [["Material", "Qty Ordered", "Qty Received", "Unit", "Unit Cost", "Line Total"]],
    body: [
      [
        opts.material_name,
        opts.quantity_ordered.toString(),
        opts.quantity_received.toString(),
        opts.unit,
        opts.unit_cost != null ? pdfMoney(opts.unit_cost, currency) : "—",
        opts.unit_cost != null ? pdfMoney(opts.unit_cost * opts.quantity_ordered, currency) : "—",
      ],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  let endY: number = doc.lastAutoTable.finalY + 20;
  doc.setFontSize(10);
  doc.text(`Expected delivery: ${opts.expected_delivery_date ?? "—"}`, 40, endY);
  endY += 16;
  doc.text(`Issued by: ${opts.issued_by_name}`, 40, endY);
  endY += 16;
  if (opts.notes) {
    doc.text(`Notes: ${opts.notes}`, 40, endY);
    endY += 16;
  }

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

export async function generateReportPdf(
  title: string,
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
  action: PdfAction = "download",
  company?: { name?: string | null; logo_url?: string | null } | null,
  // Extra lines under the title (reporting period, printed by...).
  subtitle?: string[],
) {
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: columns.length > 6 ? "landscape" : "portrait",
  });
  const top = await drawLogoHeader(doc, company?.logo_url, 40);
  let y = top;
  if (company?.name) {
    doc.setFontSize(10);
    doc.text(company.name, 40, y);
    y += 16;
  }
  doc.setFontSize(16);
  doc.text(title, 40, y);
  y += 16;
  doc.setFontSize(9);
  for (const line of subtitle ?? []) {
    doc.text(line, 40, y);
    y += 12;
  }
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, y);
  y += 16;

  autoTable(doc, {
    startY: y,
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

// Customer account statement: advance / debt position for a period, with every
// ledger line (a sale and the advance drawn for it are one line). Built from the
// same Statement object the screen and CSV use, so all three always agree.
export async function generateCustomerStatementPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    customer: { name: string; phone?: string | null; address?: string | null };
    statement: import("./customer-account").Statement;
    periodLabel: string;
    pendingSales?: { invoice_number: string; grand_total: number }[];
    currency?: string;
  },
  action: PdfAction = "download",
) {
  const currency = opts.currency ?? "NGN";
  const cur = (n: number) => pdfMoney(n, currency);
  const st = opts.statement;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();
  const right = pageW - 40;

  const top = await drawLogoHeader(doc, opts.company.logo_url, 44);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(9);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 14);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 26);

  doc.setFontSize(18);
  doc.text("CUSTOMER ACCOUNT STATEMENT", right, top, { align: "right" });
  doc.setFontSize(9);
  doc.text(`Period: ${opts.periodLabel}`, right, top + 14, { align: "right" });
  doc.text(`Generated ${new Date().toLocaleString()}`, right, top + 26, { align: "right" });

  let y = top + 52;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(opts.customer.name, 40, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  if (opts.customer.phone) doc.text(opts.customer.phone, 40, y + 13);
  if (opts.customer.address) doc.text(opts.customer.address, 40, y + 25);

  // Position summary. Advance and debt are always separate lines — never netted.
  const summary: [string, string][] = [
    ["Advance brought forward", cur(st.opening.credit)],
    ["Debt brought forward", cur(st.opening.debt)],
    ["Advance received", cur(st.totals.advanceReceived)],
    ["Goods collected", cur(st.totals.goodsCollected)],
    ["Advance used", cur(st.totals.advanceUsed)],
    ["Debt paid off", cur(st.totals.debtSettled)],
    ["Closing advance", cur(st.closing.credit)],
    ["Closing debt", cur(st.closing.debt)],
  ];
  const colW = 200;
  summary.forEach(([label, value], i) => {
    const col = Math.floor(i / 4);
    const row = i % 4;
    const x = 360 + col * colW;
    const isClosing = i >= 6;
    doc.setFont("helvetica", isClosing ? "bold" : "normal");
    doc.setFontSize(9);
    doc.text(label, x, y + row * 14);
    doc.text(value, x + colW - 20, y + row * 14, { align: "right" });
  });
  doc.setFont("helvetica", "normal");
  y += 4 * 14 + 14;

  const dateStr = (iso: string) => new Date(iso).toLocaleDateString("en-GB");
  const body: string[][] = [];
  if (opts.statement.range.from) {
    body.push([
      dateStr(`${opts.statement.range.from}T00:00:00`),
      "",
      "Balance brought forward",
      "",
      "",
      "",
      cur(st.opening.credit),
      cur(st.opening.debt),
    ]);
  }
  st.rows.forEach((r) =>
    body.push([
      dateStr(r.date),
      r.reference === "—" ? "" : r.reference,
      r.description,
      `${r.sign === "-" ? "-" : r.sign === "+" ? "+" : ""}${cur(r.amount)}`,
      r.paid && r.paid > 0 ? cur(r.paid) : "",
      r.advanceUsed && r.advanceUsed > 0 ? cur(r.advanceUsed) : "",
      r.creditAfter === null ? "" : cur(r.creditAfter),
      r.debtAfter === null ? "" : cur(r.debtAfter),
    ]),
  );
  body.push(["", "", "Closing balance", "", "", "", cur(st.closing.credit), cur(st.closing.debt)]);

  autoTable(doc, {
    startY: y,
    head: [
      [
        "Date",
        "Reference",
        "Description",
        "Amount",
        "Paid",
        "Advance used",
        "Advance balance",
        "Debt balance",
      ],
    ],
    body,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [30, 41, 59] },
    columnStyles: {
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right" },
    },
    didParseCell: (d) => {
      if (d.section === "body" && d.row.index === body.length - 1) d.cell.styles.fontStyle = "bold";
    },
    didDrawPage: () => {
      const n = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.text(`Page ${n}`, right, doc.internal.pageSize.getHeight() - 20, { align: "right" });
    },
  });

  // @ts-expect-error autoTable augments doc
  let after: number = doc.lastAutoTable.finalY + 16;
  const pending = opts.pendingSales ?? [];
  if (pending.length > 0) {
    doc.setFontSize(8);
    doc.text(
      `${pending.length} sale(s) awaiting approval are not included above: ${pending
        .map((p) => `${p.invoice_number} (${cur(p.grand_total)})`)
        .join(", ")}.`,
      40,
      after,
      { maxWidth: pageW - 80 },
    );
    after += 14;
  }
  doc.setFontSize(8);
  doc.text(
    "Advance is money the customer has paid that has not yet been used against goods. Debt is the value of goods collected that has not yet been paid for. The two are shown separately.",
    40,
    after,
    { maxWidth: pageW - 80 },
  );

  if (action === "download") {
    doc.save(`Statement-${opts.customer.name.replace(/\s+/g, "-")}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

// Production hall stock report: per product, what was in the hall at the start
// of the period, what was produced, what was released to the Warehouse, and
// what is still in the hall at the end. Laid out like the department's
// existing paper report (centred letterhead, blue table).
export async function generateProductionStockReportPdf(
  opts: {
    company: {
      name?: string | null;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      logo_url?: string | null;
    };
    from: string;
    to: string;
    rows: {
      product: string;
      opening: number;
      produced: number;
      total: number;
      released: number;
      // Unreleased stock cleared from the hall (production_hall_clearances).
      cleared?: number;
      balance: number;
    }[];
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const withCleared = opts.rows.some((r) => (r.cleared ?? 0) !== 0);
  let y = await drawLogoHeader(doc, opts.company.logo_url, 40, 140, 60);
  doc.setFont("times", "bold");
  if (opts.company.name) {
    doc.setFontSize(13);
    doc.text(opts.company.name, pageW / 2, y, { align: "center" });
    y += 15;
  }
  doc.setFontSize(10);
  if (opts.company.address) {
    doc.text(opts.company.address, pageW / 2, y, { align: "center", maxWidth: pageW - 80 });
    y += 14;
  }
  const contact = [
    opts.company.phone ? `Tel: ${opts.company.phone}` : "",
    opts.company.email ? `Email: ${opts.company.email}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (contact) {
    doc.text(contact, pageW / 2, y, { align: "center" });
    y += 14;
  }
  y += 18;
  doc.setFontSize(12);
  doc.text(`PRODUCTION DEPARTMENT: PRODUCTS REPORT FROM ${opts.from} TO ${opts.to}`, pageW / 2, y, {
    align: "center",
  });
  y += 12;

  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  autoTable(doc, {
    startY: y,
    head: [
      [
        "S/N",
        "Product",
        "Opening",
        "Produced",
        "Total",
        "Released",
        ...(withCleared ? ["Cleared"] : []),
        "Balance",
      ],
    ],
    body: opts.rows.map((r, i) => [
      String(i + 1),
      r.product,
      n(r.opening),
      n(r.produced),
      n(r.total),
      n(r.released),
      ...(withCleared ? [n(r.cleared ?? 0)] : []),
      n(r.balance),
    ]),
    styles: { font: "times", fontSize: 10, lineColor: [0, 0, 0], lineWidth: 0.5 },
    headStyles: { fillColor: [31, 101, 196], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 34 } },
    margin: { left: 30, right: 30 },
  });

  if (action === "download") {
    doc.save(`production-report-${opts.from}-to-${opts.to}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

// Items Sold to Customers: laid out like the accounting package's printout the
// office already files — period heading, one block per customer, bold
// customer subtotals, grand total, and "Page n of m" on every page.
export async function generateItemsSoldPdf(
  opts: {
    company: { name?: string | null; logo_url?: string | null };
    report: import("./items-sold-report").ItemsSoldReport;
    periodLabel: string;
    printedBy?: string | null;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();
  const printedAt = new Date().toLocaleString();
  let y = await drawLogoHeader(doc, opts.company.logo_url, 40, 130, 60);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text((opts.company.name ?? "Elim Table Water").toUpperCase(), pageW / 2, y, {
    align: "center",
  });
  y += 16;
  doc.setFontSize(11);
  doc.text("Items Sold to Customers", pageW / 2, y, { align: "center" });
  y += 15;
  doc.text(`For the Period ${opts.periodLabel}`, pageW / 2, y, { align: "center" });
  y += 13;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(
    "Posted sales only (PR excluded). Report order is by Customer ID, Item." +
      (opts.printedBy ? `  Printed by: ${opts.printedBy}` : ""),
    40,
    y,
  );
  y += 8;

  const qty = (n: number) =>
    new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      n,
    );
  type Row = { cells: string[]; kind: "item" | "subtotal" | "total" };
  const body: Row[] = [];
  for (const g of opts.report.groups) {
    g.items.forEach((i, idx) =>
      body.push({
        kind: "item",
        cells: [
          idx === 0 ? (g.code ?? "") : "",
          idx === 0 ? g.name : "",
          i.product,
          qty(i.quantity),
          i.unit ?? "",
          qty(i.amount),
        ],
      }),
    );
    body.push({ kind: "subtotal", cells: ["", "", "", qty(g.quantity), "", qty(g.amount)] });
  }
  body.push({
    kind: "total",
    cells: [
      "",
      "",
      `GRAND TOTAL — ${opts.report.groups.length} customer(s)`,
      qty(opts.report.quantity),
      "",
      qty(opts.report.amount),
    ],
  });

  autoTable(doc, {
    startY: y,
    head: [["Customer ID", "Name", "Item", "Qty", "Stocking U/M", "Amount"]],
    body: body.map((r) => r.cells),
    theme: "plain",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 3 },
    headStyles: { fontStyle: "bold", lineWidth: { bottom: 0.8 }, lineColor: [0, 0, 0] },
    columnStyles: {
      0: { cellWidth: 90 },
      1: { cellWidth: 180 },
      3: { halign: "right", cellWidth: 80 },
      4: { cellWidth: 80 },
      5: { halign: "right", cellWidth: 110 },
    },
    margin: { left: 40, right: 40, top: 40 },
    didParseCell: (d) => {
      if (d.section !== "body") return;
      const kind = body[d.row.index]?.kind;
      if (kind === "subtotal" || kind === "total") {
        d.cell.styles.fontStyle = "bold";
        // Subtotals rule off just the Qty and Amount columns; the grand total spans.
        const ruled = kind === "total" || d.column.index === 3 || d.column.index === 5;
        d.cell.styles.lineWidth = { top: ruled ? (kind === "total" ? 1 : 0.5) : 0 };
        d.cell.styles.lineColor = [0, 0, 0];
        if (kind === "total") d.cell.styles.fontSize = 10;
        // Space between customer blocks, like the printout.
        else d.cell.styles.cellPadding = { top: 3, bottom: 12, left: 3, right: 3 };
      }
    },
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(printedAt, 40, 24);
    doc.text(`Page ${p} of ${pages}`, pageW - 40, 24, { align: "right" });
  }

  if (action === "download") {
    doc.save(`items-sold-to-customers-${opts.periodLabel.replace(/[^\w-]+/g, "-")}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

// Marketer daily sales sheet: one page (or more) per marketer, Elim logo at the
// top centre, "NAME (SEP, 2026)" heading, a gridded day-by-day table and a
// TOTAL line — the layout of the sheet the office already keeps by hand.
export async function generateMarketerSheetPdf(
  opts: {
    company: { name?: string | null; logo_url?: string | null };
    sheets: (import("./marketer-sales-sheet").MarketerSheet & {
      kind?: import("./marketer-sales-sheet").PartyKind;
    })[];
    periodLabel: string;
    printedBy?: string | null;
    // Every-party print (Finance overview): a first page with one line per
    // party, a subtotal per group (marketers, retail, ...) and a grand total.
    summary?: boolean;
    fileName?: string;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const logo = await resolveLogo(opts.company.logo_url);
  const num = (v: number) =>
    v === 0 ? "-" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v);
  const drawLogo = () => {
    if (!logo) return 40;
    const ratio = Math.min(130 / logo.width, 60 / logo.height, 1);
    const w = logo.width * ratio,
      h = logo.height * ratio;
    doc.addImage(logo.dataUrl, "PNG", pageW / 2 - w / 2, 24, w, h);
    return 24 + h + 22;
  };
  const sheetStyles = {
    theme: "grid" as const,
    styles: {
      font: "helvetica",
      fontSize: 9,
      lineColor: [0, 0, 0] as [number, number, number],
      lineWidth: 0.5,
      textColor: [0, 0, 0] as [number, number, number],
      halign: "right" as const,
    },
    headStyles: {
      fillColor: [255, 255, 255] as [number, number, number],
      fontStyle: "bold" as const,
      valign: "bottom" as const,
    },
    margin: { left: 36, right: 36 },
  };

  if (opts.summary) {
    const y = drawLogo();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(`MONTHLY PERFORMANCE  (${opts.periodLabel})`, pageW / 2, y, { align: "center" });
    const figures = (t: Omit<import("./marketer-sales-sheet").SheetRow, "day">) => [
      num(t.total),
      num(t.credit),
      num(t.cash),
      num(t.recovery),
      num(t.remitted),
    ];
    const body: string[][] = [];
    const bold = new Set<number>();
    for (const k of PARTY_KINDS) {
      const group = opts.sheets.filter((s) => s.kind === k.kind);
      if (group.length === 0) continue;
      bold.add(body.length);
      body.push([k.label.toUpperCase(), "", "", "", "", ""]);
      for (const s of group)
        body.push([s.code ? `${s.name} (${s.code})` : s.name, ...figures(s.totals)]);
      bold.add(body.length);
      body.push([
        `TOTAL ${k.label.toUpperCase()}`,
        ...figures(sheetTotals(group.map((s) => ({ day: "", ...s.totals })))),
      ]);
    }
    bold.add(body.length);
    body.push([
      "GRAND TOTAL",
      ...figures(sheetTotals(opts.sheets.map((s) => ({ day: "", ...s.totals })))),
    ]);
    autoTable(doc, {
      ...sheetStyles,
      startY: y + 10,
      head: [
        ["NAME", "TOTAL SALES", "CREDIT SALES", "CASH SALES", "Recovery", "TOTAL CASH REMITTED"],
      ],
      body,
      columnStyles: { 0: { cellWidth: 170 } },
      didParseCell: (d) => {
        if (d.column.index === 0) d.cell.styles.halign = "left";
        if (d.section === "body" && bold.has(d.row.index)) d.cell.styles.fontStyle = "bold";
      },
    });
  }

  opts.sheets.forEach((s, idx) => {
    if (idx > 0 || opts.summary) doc.addPage();
    let y = drawLogo();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(`${s.name.toUpperCase()}  (${opts.periodLabel})`, pageW / 2, y, { align: "center" });
    if (s.code) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      const idLabel = PARTY_KINDS.find((k) => k.kind === s.kind)?.idLabel ?? "Marketer ID";
      doc.text(`${idLabel}: ${s.code}`, pageW / 2, y + 13, { align: "center" });
      y += 13;
    }
    autoTable(doc, {
      startY: y + 10,
      head: [
        ["DATE", "TOTAL SALES", "CREDIT SALES", "CASH SALES", "Recovery", "TOTAL CASH REMITTED"],
      ],
      body: [
        ...s.rows.map((r) => [
          sheetDayLabel(r.day),
          num(r.total),
          num(r.credit),
          num(r.cash),
          num(r.recovery),
          num(r.remitted),
        ]),
        [
          "TOTAL",
          num(s.totals.total),
          num(s.totals.credit),
          num(s.totals.cash),
          num(s.totals.recovery),
          num(s.totals.remitted),
        ],
      ],
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 9,
        lineColor: [0, 0, 0],
        lineWidth: 0.5,
        textColor: [0, 0, 0],
        halign: "right",
      },
      headStyles: { fillColor: [255, 255, 255], fontStyle: "bold", valign: "bottom" },
      columnStyles: { 0: { cellWidth: 170 } },
      margin: { left: 36, right: 36 },
      didParseCell: (d) => {
        if (d.column.index === 0 && d.section === "head") d.cell.styles.halign = "left";
        if (d.section === "body" && d.row.index === s.rows.length) {
          d.cell.styles.fontStyle = "bold";
          if (d.column.index === 0) d.cell.styles.halign = "left";
        }
      },
    });
  });

  const pages = doc.getNumberOfPages();
  const printedAt = new Date().toLocaleString();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    const foot = [
      opts.company.name,
      `Printed ${printedAt}`,
      opts.printedBy && `by ${opts.printedBy}`,
    ]
      .filter(Boolean)
      .join("  ·  ");
    doc.text(foot, 36, doc.internal.pageSize.getHeight() - 18);
    doc.text(`Page ${p} of ${pages}`, pageW - 36, doc.internal.pageSize.getHeight() - 18, {
      align: "right",
    });
  }

  if (action === "download") {
    doc.save(
      `${opts.fileName ?? "marketer-sales-sheet"}-${opts.periodLabel.replace(/[^\w-]+/g, "-")}.pdf`,
    );
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
