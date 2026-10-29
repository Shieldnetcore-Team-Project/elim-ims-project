import type { RollReceipt } from "@/lib/pdf";

// Prints the Warehouse's slim LOAD ORDER RECEIPT straight to the POS printer
// as a plain page, not a PDF. The browser's PDF viewer turns a PDF into a
// picture -- thin, faint text on a thermal roll -- adds its own margins that
// cut the edges, and rescales multi-page PDFs. Here the text is solid black
// bold type in a 70mm column (the roll prints 72mm), page margins are off,
// and each copy is its own page, so every copy prints exactly like one.

const FALLBACK_LOGO_URL = "/assets/elim-logo.png";

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const amt = (n: number) => Math.round(n).toLocaleString("en-US");
const naira = (n: number) => `N${amt(n)}`;

function dateParts(at: Date) {
  const day = at.getDate();
  const nth =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  return {
    date: `${at.toLocaleDateString("en-GB", { weekday: "long" })} ${day}${nth} ${at.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}`,
    time: at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

function receiptHtml(r: RollReceipt, logo: string) {
  const { date, time } = dateParts(r.at);
  const row = (label: string, value: string, bold = false) =>
    `<tr class="${bold ? "strong" : ""}"><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`;
  return `
<section class="receipt">
  <img class="logo" src="${esc(logo)}" alt="" />
  ${r.company.address ? `<div class="c small">${esc(r.company.address)}</div>` : ""}
  ${r.company.phone ? `<div class="c small">${esc(r.company.phone)}</div>` : ""}
  <div class="split gap"><span>${esc(date)}</span><span>${esc(time)}</span></div>
  <h1>${esc(r.title)}</h1>
  <table class="parties">
    <tr><td>Trans. ID:</td><td>Sales Rep.:</td><td>${esc(r.party_label)}:</td></tr>
    <tr class="v"><td>${esc(r.trans_id)}</td><td>${esc(r.sales_rep || "—")}</td><td>${esc(r.party)}</td></tr>
  </table>
  <div class="gap">Transaction Details</div>
  <table class="items">
    <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price(N)</th><th class="r">Amount(N)</th></tr></thead>
    <tbody>
      ${r.items
        .map(
          (it) =>
            `<tr><td>${esc(it.name)}</td><td class="r">${amt(it.quantity)}</td><td class="r">${amt(it.unit_price)}</td><td class="r">${amt(it.amount)}</td></tr>`,
        )
        .join("")}
    </tbody>
  </table>
  <table class="totals">
    ${row("Subtotal", naira(r.subtotal))}
    ${row("Surcharge", naira(r.surcharge))}
    ${row("Discount", naira(r.discount))}
    ${row("Amount to pay", naira(r.total), true)}
    ${(r.extra ?? []).map(([l, v]) => row(l, naira(v))).join("")}
  </table>
  ${r.note ? `<div class="small gap">${esc(r.note)}</div>` : ""}
  <div class="c strong gap">Thank you for your patronage!</div>
</section>`;
}

const STYLE = `
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  width: 72mm; padding: 2mm 1mm 4mm;
  font-family: "Courier New", Courier, monospace; font-weight: 700; color: #000;
  font-size: 9pt; line-height: 1.25;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.receipt { width: 70mm; }
.receipt + .receipt { break-before: page; page-break-before: always; }
.logo { display: block; max-width: 48mm; max-height: 18mm; margin: 0 auto 2mm; }
.c { text-align: center; }
.r { text-align: right; white-space: nowrap; }
.small { font-size: 8pt; }
.strong { font-weight: 900; }
.gap { margin-top: 2.5mm; }
.split { display: flex; justify-content: space-between; gap: 2mm; font-size: 8pt; }
h1 { font-size: 13pt; font-weight: 900; text-align: center; margin: 2.5mm 0; letter-spacing: 0.3px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 0.4mm 0; vertical-align: top; word-break: break-word; }
.parties { font-size: 7pt; table-layout: fixed; }
.parties td { padding-right: 1mm; }
.parties td:nth-child(1) { width: 38%; }
.parties td:nth-child(2) { width: 26%; }
.parties tr:first-child td { white-space: nowrap; }
.parties .v td { font-weight: 900; }
.items { margin-top: 1mm; font-size: 8pt; }
/* Smaller headings, so the number columns stay narrow and names fit. */
.items th { text-align: left; font-size: 6.5pt; border-bottom: 1.5px solid #000; padding-bottom: 0.8mm; }
.items th.r { text-align: right; }
.items td:not(:first-child), .items th:not(:first-child) { padding-left: 1.5mm; }
/* The item name takes whatever the number columns leave. */
.items td:first-child, .items th:first-child { width: 100%; }
.totals { margin-top: 2mm; border-top: 1.5px dashed #000; padding-top: 1mm; }
.totals td { padding-top: 0.8mm; }
.totals .strong td { font-size: 10pt; }
`;

export async function printRollReceipt(r: RollReceipt, copies = 1) {
  const logo = r.company.logo_url || FALLBACK_LOGO_URL;
  const n = Math.max(1, Math.floor(copies));
  const html = `<!doctype html><html><head><meta charset="utf-8" /><title>${esc(r.file_name)}</title><style>${STYLE}</style></head><body>${Array.from({ length: n }, () => receiptHtml(r, logo)).join("")}</body></html>`;

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();

  // Print once the logo has loaded (or failed), so it is on the receipt.
  const images = Array.from(doc.images);
  await Promise.all(
    images.map((img) =>
      img.complete
        ? null
        : new Promise((res) => {
            img.onload = res;
            img.onerror = () => {
              img.remove();
              res(null);
            };
          }),
    ),
  );
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  // Remove the frame after the print dialog has closed.
  setTimeout(() => frame.remove(), 60_000);
}
