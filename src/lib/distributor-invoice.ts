import jsPDF from "jspdf";
import { resolveLogo, type PdfAction } from "./pdf";

// The A4 invoice for marketer and distributor sales, drawn to match the
// company's own printed invoice:
//   company name, address and Tel/Email/Website down the left
//   logo with "INVOICE" under it on the right, then Invoice No / Date/Time
//   BILLED TO box (blue title bar)
//   Marketer/Distributor ID and Delivery Method rows
//   item grid: blue header, column lines only (no row lines), a tall body,
//     and a blank "Remarks on return" column filled in by hand
//   Subtotal / VAT / Total / Paid / Balance under the grid on the right
// Walk-in and retail-shop sales keep the plain receipt (generateInvoicePdf).

export type DistributorInvoiceData = {
  company: {
    name: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    logo_url?: string | null;
  };
  invoice_number: string;
  issued_at: string; // date or timestamp
  customer: { name?: string | null; address?: string | null; phone?: string | null };
  party_id: string | null; // marketer / distributor ID
  party_label?: string | null; // e.g. the marketer's name
  delivery_method: string;
  items: { name: string; quantity: number; unit_price: number; line_total: number }[];
  subtotal: number;
  discount: number;
  vat: number;
  vat_rate?: number | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
  remarks?: string | null;
  is_pr?: boolean;
};

type RGB = [number, number, number];
const BLUE: RGB = [52, 140, 230];
const HEAD_TEXT: RGB = [215, 235, 255];
const INK: RGB = [25, 28, 36];
const LINE: RGB = [70, 78, 92];

// Figures as on the printed form -- no forced decimals -- but with thousands
// commas. jsPDF's built-in fonts have no ₦ glyph, so money prints as "N256,800".
const fig = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

function fmtIssued(s: string): string {
  // A plain date prints as the date; a timestamp prints as YYYY-MM-DD HH:MM:SS.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

export async function generateDistributorInvoicePdf(
  data: DistributorInvoiceData,
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const right = W - M;
  const contentW = right - M;
  const logo = await resolveLogo(data.company.logo_url);

  doc.setTextColor(...INK);
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.8);
  doc.setFont("times", "bold");

  // ------------------------------------------------------- letterhead (left)
  let y = M + 26;
  doc.setFontSize(28);
  for (const ln of doc.splitTextToSize(
    (data.company.name || "Company").toUpperCase(),
    contentW,
  ) as string[]) {
    doc.text(ln, M, y);
    y += 28;
  }
  y -= 10;
  doc.setFontSize(11);
  if (data.company.address) {
    for (const ln of doc.splitTextToSize(data.company.address, contentW * 0.66) as string[]) {
      doc.text(ln, M, y);
      y += 14;
    }
  }
  y += 18;
  const contactTop = y;
  for (const ln of [
    data.company.phone && `Tel: ${data.company.phone}`,
    data.company.email && `Email: ${data.company.email}`,
    data.company.website && `Website: ${data.company.website}`,
  ].filter(Boolean) as string[]) {
    doc.text(ln, M, y);
    y += 15;
  }
  const leftBottom = y;

  // ------------------------------------------ logo + INVOICE (right column)
  const colCenter = right - 85;
  let ry = contactTop - 12;
  if (logo) {
    const maxW = 130,
      maxH = 60;
    const r = Math.min(maxW / logo.width, maxH / logo.height, 1);
    const w = logo.width * r,
      h = logo.height * r;
    doc.addImage(logo.dataUrl, "PNG", colCenter - w / 2, ry, w, h);
    ry += h + 32;
  } else {
    ry += 30;
  }
  doc.setFontSize(data.is_pr ? 18 : 30);
  doc.text(data.is_pr ? "PR / COMPLIMENTARY" : "INVOICE", colCenter, ry, { align: "center" });

  // ------------------------------------------------------------ BILLED TO
  const boxTop = Math.max(leftBottom + 18, ry - 12);
  const boxW = contentW * 0.56;
  const barH = 17;
  doc.setFontSize(11.5);
  const billed = (
    [
      (data.customer.name || "Walk-in customer").toUpperCase(),
      data.customer.address?.toUpperCase(),
      data.customer.phone,
    ].filter(Boolean) as string[]
  ).flatMap((l) => doc.splitTextToSize(l, boxW - 10) as string[]);
  const boxH = barH + 8 + Math.max(3, billed.length) * 14;
  doc.setFillColor(...BLUE);
  doc.rect(M, boxTop, boxW, barH, "F");
  doc.setTextColor(255, 255, 255);
  doc.text("BILLED TO", M + 4, boxTop + 12.5);
  doc.setTextColor(...INK);
  doc.rect(M, boxTop, boxW, boxH);
  let by = boxTop + barH + 12;
  for (const ln of billed) {
    doc.text(ln, M + 4, by);
    by += 14;
  }

  // Invoice No / Date, right-aligned level with the bottom of the box.
  doc.setFontSize(10.5);
  const metaY = Math.max(boxTop + boxH - 20, ry + 30);
  doc.text(`Invoice No: ${data.invoice_number}`, right, metaY, { align: "right" });
  doc.text(`Date/Time: ${fmtIssued(data.issued_at)}`, right, metaY + 14, { align: "right" });

  // --------------------------------------- ID + delivery method (two rows)
  y = Math.max(boxTop + boxH, metaY + 14) + 12;
  const rowH = 17;
  const splitX = M + contentW * 0.69;
  doc.setFontSize(11);
  const infoRows: [string, string][] = [
    [
      "Marketer/Distributor ID",
      [data.party_id, data.party_label].filter(Boolean).join(" — ") || "",
    ],
    ["Delivery Method", data.delivery_method],
  ];
  infoRows.forEach(([label, value], i) => {
    const top = y + i * rowH;
    doc.rect(M, top, contentW, rowH);
    doc.text(label, M + 4, top + 12.5);
    doc.text(value, splitX + 4, top + 12.5);
  });
  doc.line(splitX, y, splitX, y + rowH * infoRows.length);
  y += rowH * infoRows.length + 6;

  // ------------------------------------------------------------ item grid
  const cols = [
    { title: "S/N", w: 0.054 },
    { title: "PRODUCT DESCRIPTION", w: 0.277 },
    { title: "QUANTITY", w: 0.159 },
    { title: "UNIT COST(N)", w: 0.149 },
    { title: "AMOUNT(N)", w: 0.167 },
    { title: "REMARKS ON RETURN", w: 0.194 },
  ];
  const xs: number[] = [M];
  cols.forEach((c) => xs.push(xs[xs.length - 1] + c.w * contentW));
  xs[xs.length - 1] = right;

  const headH = 18;
  doc.setFillColor(...BLUE);
  doc.rect(M, y, contentW, headH, "F");
  doc.setTextColor(...HEAD_TEXT);
  cols.forEach((c, i) => {
    // Shrink a heading that would not fit its column.
    let size = 10;
    doc.setFontSize(size);
    while (size > 7 && doc.getTextWidth(c.title) > xs[i + 1] - xs[i] - 6)
      doc.setFontSize((size -= 0.5));
    doc.text(c.title, xs[i] + 3, y + 12.5);
  });
  doc.setTextColor(...INK);

  const bodyTop = y + headH;
  const lineH = 16;
  doc.setFont("times", "normal");
  doc.setFontSize(11);
  let iy = bodyTop + 15;
  data.items.forEach((it, i) => {
    const nameLines = doc.splitTextToSize(it.name, xs[2] - xs[1] - 8) as string[];
    doc.text(String(i + 1), xs[0] + 4, iy);
    nameLines.forEach((ln, k) => doc.text(ln, xs[1] + 8, iy + k * 12));
    doc.text(fig(it.quantity), xs[2] + 8, iy);
    doc.text(fig(it.unit_price), xs[3] + 8, iy);
    doc.text(fig(it.line_total), xs[4] + 8, iy);
    iy += lineH + (nameLines.length - 1) * 12;
  });
  // A tall body like the printed form; grows for a long list.
  const bodyBottom = Math.max(bodyTop + 300, iy + 6);
  doc.rect(M, y, contentW, bodyBottom - y);
  xs.slice(1, -1).forEach((x) => doc.line(x, y, x, bodyBottom));
  y = bodyBottom;

  // --------------------------------------------------------------- totals
  doc.setFont("times", "bold");
  const tLeft = xs[3] + 20;
  const tSplit = xs[5] + 2;
  const tRow = 16;
  const vatLabel =
    data.vat_rate != null && data.vat_rate > 0
      ? `${fig(Number(data.vat_rate))}% VAT Applicable`
      : "VAT Applicable";
  const totals: [string, string][] = data.is_pr
    ? [
        ["Value of goods issued", `N${fig(data.subtotal)}`],
        ["Not billed - no payment due", "N0"],
      ]
    : [
        ["Subtotal", `N${fig(data.subtotal)}`],
        ...(data.discount > 0
          ? ([["Discount", `-N${fig(data.discount)}`]] as [string, string][])
          : []),
        [vatLabel, data.vat > 0 ? `N${fig(data.vat)}` : ""],
        ["Total", `N${fig(data.grand_total)}`],
        ["Amount Paid", `N${fig(data.amount_paid)}`],
        ["Balance Due", `N${fig(data.balance)}`],
      ];
  if (y + totals.length * tRow + 40 > H) {
    doc.addPage();
    y = M;
  }
  doc.setFontSize(10.5);
  totals.forEach(([label, value], i) => {
    const top = y + i * tRow;
    doc.rect(tLeft, top, right - tLeft, tRow);
    doc.text(label, tLeft + 4, top + 12);
    doc.text(value, right - 4, top + 12, { align: "right" });
  });
  doc.line(tSplit, y, tSplit, y + totals.length * tRow);

  if (data.remarks) {
    doc.setFont("times", "normal");
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(`Remarks: ${data.remarks}`, tLeft - M - 12) as string[];
    lines.forEach((ln, i) => doc.text(ln, M, y + 12 + i * 12));
  }

  if (action === "download") {
    doc.save(`${data.invoice_number.replace(/[\\/]/g, "-")}.pdf`);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
