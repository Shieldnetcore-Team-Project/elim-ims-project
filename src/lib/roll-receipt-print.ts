import type { RollReceipt } from "@/lib/pdf";

// Prints the Warehouse's slim LOAD ORDER RECEIPT straight to the POS printer
// as a plain page, not a PDF. The browser's PDF viewer turns a PDF into a
// picture -- thin, faint text on a thermal roll -- adds its own margins that
// cut the edges, and rescales multi-page PDFs. Here the text is solid black
// in a 70mm column (the roll prints 72mm), page margins are off, and each
// copy is its own page, so every copy prints exactly like one. The type is
// solid black bold in an even-stroked mono font, a hair thickened, and the
// logo pure black and white: thermal heads print grey as faint, fuzzy dots
// (the user's choice, 2026-10-30: dark, sharp and clean).

const FALLBACK_LOGO_URL = "/assets/elim-logo.png";

// The logo, fetched once and kept as a data URL, so later prints don't wait
// on the network. Until it is in (or when fetch is refused, e.g. another
// host without CORS) the plain url is used, and printing waits for it at most
// LOGO_WAIT_MS.
const LOGO_WAIT_MS = 1200;
// .logo's max-height plus its bottom margin, in mm.
const LOGO_MAX_MM = 20;
// One inch of roll added to every receipt's length.
const EXTRA_LENGTH_MM = 25;
const logos = new Map<string, Promise<string>>();
function cachedLogo(url: string): Promise<string> {
  let p = logos.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(
        (b) =>
          new Promise<string>((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = rej;
            fr.readAsDataURL(b);
          }),
      )
      .catch(() => {
        logos.delete(url); // try again next print
        return url;
      });
    logos.set(url, p);
  }
  return Promise.race([p, new Promise<string>((res) => setTimeout(() => res(url), LOGO_WAIT_MS))]);
}

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

function receiptHtml(r: RollReceipt, logo: string, label?: string) {
  const { date, time } = dateParts(r.at);
  const row = (label: string, value: string, bold = false) =>
    `<tr class="${bold ? "strong" : ""}"><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`;
  return `
<section class="receipt">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ""}
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
  <div class="c thanks gap">Thank you for your patronage!</div>
  ${label ? `<div class="c copy-label gap">${esc(label)}</div>` : ""}
  <div class="tear">- - - - - - - cut here - - - - - - -</div>
</section>`;
}

// The Retail Shop's sale slip, set like an ESC/POS thermal receipt (user's
// spec, 2026-10-31): 80mm roll at 203 DPI, monospaced text in fixed columns.
// Body in Font A (12 x 24 dots, 48 characters a line), the title double
// height, Transaction Details in the smaller Font B (9 x 17 dots, 64 a line),
// regular weight, labels left and amounts right. The browser can't send the
// printer's own fonts, so each line is padded to its column count and the
// mono font sized (fitEscpos) so a line fills the roll's printable width.
const FONT_A_COLS = 48;
const FONT_B_COLS = 64;

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) out.push(line);
        out.push(word.slice(0, width));
        word = word.slice(width);
        line = "";
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}
const centre = (text: string, width: number) =>
  wrap(text, width).map((ln) => " ".repeat(Math.floor((width - ln.length) / 2)) + ln);
// Label left, value right; a pair too long for one line puts the value on
// the next line, still set right.
function leftRight(left: string, right: string, width: number): string[] {
  if (left.length + 1 + right.length <= width)
    return [left + " ".repeat(width - left.length - right.length) + right];
  return [...wrap(left, width), ...wrap(right, width).map((ln) => ln.padStart(width))];
}
const rule = (ch: string, width: number) => ch.repeat(width);

function escposHtml(r: RollReceipt, logo: string, label?: string) {
  const { date, time } = dateParts(r.at);
  const A = FONT_A_COLS;
  const B = FONT_B_COLS;
  const block = (font: "fa" | "fb", lines: string[], cls = "") =>
    `<pre class="${font}${cls ? ` ${cls}` : ""}">${esc(lines.join("\n"))}</pre>`;

  // Item | Qty | Price(N) | Amount(N) in Font B; the name wraps in its column.
  const QTY = 7;
  const PRICE = 11;
  const AMOUNT = 12;
  const ITEM = B - QTY - PRICE - AMOUNT;
  const itemRow = (name: string, qty: string, price: string, amount: string) =>
    name.padEnd(ITEM) + qty.padStart(QTY) + price.padStart(PRICE) + amount.padStart(AMOUNT);
  const items: string[] = [itemRow("Item", "Qty", "Price(N)", "Amount(N)"), rule("-", B)];
  for (const it of r.items) {
    const name = wrap(it.name, ITEM - 1);
    items.push(itemRow(name[0], amt(it.quantity), amt(it.unit_price), amt(it.amount)));
    for (const ln of name.slice(1)) items.push(ln);
  }

  const totals = [
    ...leftRight("Subtotal", naira(r.subtotal), A),
    ...leftRight("Surcharge", naira(r.surcharge), A),
    ...leftRight("Discount", naira(r.discount), A),
  ];
  const extra = (r.extra ?? []).flatMap(([l, v]) => leftRight(l, naira(v), A));

  return `
<section class="receipt escpos">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ""}
  ${block("fa", [
    ...(logo || !r.company.name ? [] : centre(r.company.name, A)),
    ...(r.company.address ? centre(r.company.address, A) : []),
    ...(r.company.phone ? centre(r.company.phone, A) : []),
    "",
    ...leftRight(date, time, A),
  ])}
  <div class="fa dh">${centre(r.title, A)
    .map((ln) => `<span><i>${esc(ln)}</i></span>`)
    .join("")}</div>
  ${block("fa", [
    ...leftRight("Trans. ID:", r.trans_id, A),
    ...leftRight("Sales Rep.:", r.sales_rep || "-", A),
    ...leftRight(`${r.party_label}:`, r.party, A),
    rule("=", A),
    "Transaction Details",
  ])}
  ${block("fb", items)}
  ${block("fa", [rule("-", A), ...totals])}
  ${block("fa", leftRight("Amount to pay", naira(r.total), A), "em")}
  ${extra.length ? block("fa", extra) : ""}
  ${r.note ? block("fb", ["", ...wrap(r.note, B)]) : ""}
  ${block("fa", ["", ...centre("Thank you for your patronage!", A)], "em")}
  ${label ? block("fa", ["", ...centre(label, A)], "em") : ""}
  ${block("fa", ["", centre("- - - - - - cut here - - - - - -", A)[0]])}
</section>`;
}

// Sizes the ESC/POS slips' mono font so a Font A line (48 characters) spans
// ESCPOS_LINE_MM, whatever mono font the computer has; Font B is 48/64 of it.
const ESCPOS_LINE_MM = 71;
function fitEscpos(doc: Document) {
  if (!doc.querySelector(".escpos")) return;
  const probe = doc.createElement("pre");
  probe.className = "fa";
  probe.style.cssText = "position:absolute;visibility:hidden;font-size:100px;margin:0";
  probe.textContent = "0".repeat(FONT_A_COLS);
  doc.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  if (!width) return;
  const px = (100 * ESCPOS_LINE_MM * 96) / 25.4 / width;
  const fit = doc.createElement("style");
  fit.textContent = `.escpos .fa { font-size: ${px.toFixed(3)}px; } .escpos .fb { font-size: ${((px * FONT_A_COLS) / FONT_B_COLS).toFixed(3)}px; }`;
  doc.head.appendChild(fit);
}

const STYLE = `
/* Side margins keep text off the roll's unprintable edges (the first letter
   of every line was lost at the very edge); no top/bottom margin, so the
   browser has no room to print its own date / address header and footer. */
@page { margin: 0 3mm 0 5mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
/* The receipt takes the width the print window gives it (up to the roll's
   72mm) instead of a fixed width: a fixed 80mm inside the browser's default
   margins was shrunk to fit -- small text on a long, mostly empty page. */
body {
  font-family: "Lucida Console", Consolas, "Courier New", Courier, monospace;
  font-weight: 700; color: #000;
  -webkit-text-stroke: 0.2px #000; text-rendering: geometricPrecision;
  font-size: 9pt; line-height: 1.25;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.receipt { width: 100%; max-width: 72mm; margin: 0 auto; padding-top: 1mm; }
/* After the receipt: a cut line and a short gap -- no long blank tail. */
.tear {
  margin-top: 4mm; padding-bottom: 6mm; text-align: center;
  font-size: 7pt; font-weight: 700; letter-spacing: 0.5px;
}
/* Each copy on its own page; a receipt never splits across two pages. */
.receipt + .receipt { break-before: page; page-break-before: always; }
.receipt { break-inside: avoid; page-break-inside: avoid; }
.logo {
  display: block; max-width: 48mm; max-height: 18mm; margin: 0 auto 2mm;
  filter: grayscale(1) contrast(2.5);
}
.c { text-align: center; }
.r { text-align: right; white-space: nowrap; }
.small { font-size: 8pt; }
.strong { font-weight: 900; }
.gap { margin-top: 2.5mm; }
.split { display: flex; justify-content: space-between; gap: 2mm; font-size: 7.5pt; }
/* The title and the closing thanks stand out most: bigger, with thicker
   strokes (the font has no weight past bold, so the stroke does it). */
h1 {
  font-size: 15pt; font-weight: 900; text-align: center; margin: 2.5mm 0; letter-spacing: 0.3px;
  -webkit-text-stroke: 0.7px #000;
}
.thanks { font-size: 10.5pt; font-weight: 900; -webkit-text-stroke: 0.5px #000; }
.copy-label { font-size: 9.5pt; font-weight: 900; -webkit-text-stroke: 0.4px #000; letter-spacing: 0.3px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 0.4mm 0; vertical-align: top; word-break: break-word; }
.parties { font-size: 6.5pt; table-layout: fixed; }
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
/* Summary prints: the lines under the title, many-column tables, a total row. */
.info { margin-top: 1mm; font-size: 7.5pt; }
/* Long names and labels wrap rather than widen the slip past the roll. */
.info .r { white-space: normal; }
.receipt div { overflow-wrap: anywhere; }
.items.dense { font-size: 7pt; }
.items.dense td:not(:first-child), .items.dense th:not(:first-child) { padding-left: 1mm; }
.items tfoot td { border-top: 1.5px solid #000; padding-top: 0.8mm; font-weight: 900; }
/* ESC/POS slips (escposHtml): regular weight, solid black, no stroke; the
   font size is set by fitEscpos. Font A lines are 24 dots tall (twice the
   12-dot cell), Font B 17 dots for its 9-dot cell. */
.escpos { font-family: Consolas, "Lucida Console", "Courier New", Courier, monospace; font-weight: 400; -webkit-text-stroke: 0; }
.escpos pre { margin: 0; font-family: inherit; white-space: pre; overflow: hidden; }
.escpos .fa { font-size: 2.46mm; line-height: ${(ESCPOS_LINE_MM / FONT_A_COLS) * 2}mm; }
.escpos .fb { font-size: 1.85mm; line-height: ${((ESCPOS_LINE_MM / FONT_B_COLS) * 17) / 9}mm; }
.escpos .em { font-weight: 700; }
/* Double height: each title line takes two lines, stretched upright only. */
.escpos .dh { white-space: pre; font-weight: 700; }
.escpos .dh span { display: block; height: ${(ESCPOS_LINE_MM / FONT_A_COLS) * 4}mm; }
.escpos .dh i { display: inline-block; font-style: normal; transform: scaleY(2); transform-origin: 0 0; }
`;

// All copies in one print, one after the other, each on its own page and
// ending with a "cut here" line: one Print gives every copy, cut apart by
// hand (the user's choice, 2026-10-29, over one print window per copy).
export async function printRollReceipt(r: RollReceipt, copies = 1) {
  const logo = await cachedLogo(r.company.logo_url || FALLBACK_LOGO_URL);
  // Copy i carries copy_labels[i]; the last label repeats for any more.
  const labels = r.copy_labels ?? [];
  await printRoll(
    r.file_name,
    (i) => (r.escpos ? escposHtml : receiptHtml)(r, logo, labels[Math.min(i, labels.length - 1)]),
    copies,
  );
}

// A summary on the same roll, in the same type and header as the receipt
// (Retail › Transaction Summary and Posting Log): label/value lines and
// tables of any columns.
export type RollReport = {
  company: RollReceipt["company"];
  title: string;
  at: Date;
  file_name: string;
  // Lines under the title, e.g. ["Day", "Thu 30 Oct 2026"].
  info?: [string, string][];
  sections: {
    heading?: string;
    // Columns after the first are numbers, set right.
    columns?: string[];
    rows?: string[][];
    total?: string[];
    // Label/value lines; bold ones are totals.
    lines?: [string, string, boolean?][];
  }[];
  note?: string | null;
};

function reportHtml(r: RollReport, logo: string) {
  const { date, time } = dateParts(r.at);
  const row = (label: string, value: string, bold = false) =>
    `<tr class="${bold ? "strong" : ""}"><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`;
  const cells = (cs: string[], tag: "td" | "th") =>
    cs.map((c, i) => `<${tag}${i ? ' class="r"' : ""}>${esc(c)}</${tag}>`).join("");
  const section = (s: RollReport["sections"][number]) => `
  ${s.heading ? `<div class="gap">${esc(s.heading)}</div>` : ""}
  ${
    s.columns
      ? `<table class="items${s.columns.length > 4 ? " dense" : ""}">
    <thead><tr>${cells(s.columns, "th")}</tr></thead>
    <tbody>${(s.rows ?? []).map((rw) => `<tr>${cells(rw, "td")}</tr>`).join("")}</tbody>
    ${s.total ? `<tfoot><tr>${cells(s.total, "td")}</tr></tfoot>` : ""}
  </table>`
      : ""
  }
  ${s.lines?.length ? `<table class="totals">${s.lines.map(([l, v, b]) => row(l, v, b)).join("")}</table>` : ""}`;
  return `
<section class="receipt">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ""}
  ${r.company.address ? `<div class="c small">${esc(r.company.address)}</div>` : ""}
  ${r.company.phone ? `<div class="c small">${esc(r.company.phone)}</div>` : ""}
  <div class="split gap"><span>${esc(date)}</span><span>${esc(time)}</span></div>
  <h1>${esc(r.title)}</h1>
  ${r.info?.length ? `<table class="info">${r.info.map(([l, v]) => row(l, v)).join("")}</table>` : ""}
  ${r.sections.map(section).join("")}
  ${r.note ? `<div class="small gap">${esc(r.note)}</div>` : ""}
  <div class="tear">- - - - - - - cut here - - - - - - -</div>
</section>`;
}

export async function printRollReport(r: RollReport, copies = 1) {
  const logo = await cachedLogo(r.company.logo_url || FALLBACK_LOGO_URL);
  await printRoll(r.file_name, () => reportHtml(r, logo), copies);
}

// The print page around the copies (exported for checking a slip's layout).
export const rollDocument = (fileName: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8" /><title>${esc(fileName)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
export const rollReceiptDocument = (r: RollReceipt, logo = "") =>
  rollDocument(r.file_name, (r.escpos ? escposHtml : receiptHtml)(r, logo, r.copy_labels?.[0]));
export const rollReportDocument = (r: RollReport, logo = "") =>
  rollDocument(r.file_name, reportHtml(r, logo));

async function printRoll(fileName: string, copyHtml: (i: number) => string, copies: number) {
  const n = Math.max(1, Math.floor(copies));
  const html = rollDocument(fileName, Array.from({ length: n }, (_, i) => copyHtml(i)).join(""));

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  // Hidden, but laid out at the roll's printable width (80mm less the side
  // margins) so the receipt's height is measured as it will print.
  frame.style.cssText =
    "position:fixed;left:-200mm;top:0;width:72mm;height:10mm;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();

  // Print once the logo has loaded (or failed), so it is on the receipt --
  // but never hold the print longer than LOGO_WAIT_MS for it.
  const images = Array.from(doc.images);
  await Promise.race([
    Promise.all(
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
    ),
    new Promise((res) => setTimeout(res, LOGO_WAIT_MS)),
  ]);
  // The page as long as the receipt (80mm wide) -- it grows with every
  // product line -- plus an inch to spare (the user's choice, 2026-10-30), so
  // the totals and thanks of a long receipt are never cut off, not a full
  // default page of blank roll. A logo still loading when the wait ran out
  // is not in the height yet: its full height is kept for it.
  const pxPerMm = 96 / 25.4;
  const receipt = doc.querySelector<HTMLElement>(".receipt");
  const logoPending = Array.from(doc.images).some((img) => !img.complete);
  const pageMm =
    Math.ceil((receipt?.scrollHeight ?? 0) / pxPerMm) +
    4 +
    (logoPending ? LOGO_MAX_MM : 0) +
    EXTRA_LENGTH_MM;
  fitEscpos(doc);
  const size = doc.createElement("style");
  size.textContent = `@page { size: 80mm ${pageMm}mm; }`;
  doc.head.appendChild(size);

  // Remove the frame once the print window has closed.
  const win = frame.contentWindow!;
  const closed = new Promise<void>((res) => {
    win.addEventListener("afterprint", () => res(), { once: true });
    setTimeout(res, 120_000);
  });
  win.focus();
  win.print();
  await closed;
  frame.remove();
}
