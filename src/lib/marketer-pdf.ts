import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { drawLogoHeader, pdfMoney, type PdfAction } from "./pdf";
import type {
  CustomerReportRow,
  CustomerStatement,
  Figures,
  MarketerStatement,
} from "./marketer-accounts";
import { fmtDate, lineCharged, lineCredited } from "./marketer-accounts";

// A4 statements for the marketer profile and customer pages. Built from the
// same RPC results the screens show, so paper and screen always agree.

type Company = {
  name: string;
  address?: string | null;
  phone?: string | null;
  logo_url?: string | null;
};

const qty = (v: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(v);
const HEAD: [number, number, number] = [30, 41, 59];

async function letterhead(doc: jsPDF, company: Company, title: string, lines: string[]) {
  const pageW = doc.internal.pageSize.getWidth();
  const right = pageW - 40;
  const top = await drawLogoHeader(doc, company.logo_url, 44, 80, 30);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text(company.name, 40, top);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  if (company.address) doc.text(company.address, 40, top + 12);
  if (company.phone) doc.text(company.phone, 40, top + 23);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text(title, right, top, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  lines.forEach((l, i) => doc.text(l, right, top + 12 + i * 11, { align: "right" }));
  return top + 18 + Math.max(lines.length * 11, 23);
}

function footer(doc: jsPDF) {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.text(`Generated ${new Date().toLocaleString("en-GB")}`, 40, h - 18);
    doc.text(`Page ${i} of ${pages}`, w - 40, h - 18, { align: "right" });
  }
}

function finish(doc: jsPDF, file: string, action: PdfAction) {
  footer(doc);
  if (action === "download") doc.save(file);
  else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

const lastY = (doc: jsPDF) =>
  (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

function section(doc: jsPDF, y: number, title: string) {
  if (y > doc.internal.pageSize.getHeight() - 90) {
    doc.addPage();
    y = 48;
  }
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text(title, 40, y);
  doc.setFont("helvetica", "normal");
  return y + 6;
}

// ------------------------------------------------------ marketer statement ---

export async function generateMarketerStatementPdf(
  opts: { company: Company; statement: MarketerStatement; periodLabel: string; currency?: string },
  action: PdfAction = "download",
) {
  const cur = (v: number) => pdfMoney(v, opts.currency ?? "NGN");
  const st = opts.statement;
  const p = st.period;
  const c = st.cumulative;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });

  let y = await letterhead(
    doc,
    opts.company,
    "MARKETER STATEMENT",
    [
      `${st.marketer.name}${st.marketer.code ? ` (${st.marketer.code})` : ""}`,
      `Period: ${opts.periodLabel}`,
      st.marketer.territory ? `Territory: ${st.marketer.territory}` : "",
      `Records from: ${fmtDate(st.first_activity)}`,
    ].filter(Boolean),
  );

  // The marketer's name on the left, above the first table, so the page
  // reads whose statement it is at a glance (user, 2026-10-30).
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text(
    `Marketer: ${st.marketer.name}${st.marketer.code ? ` (${st.marketer.code})` : ""}`,
    40,
    y + 4,
  );
  doc.setFont("helvetica", "normal");
  y += 20;

  // Money: period next to cumulative.
  const money = (f: (x: Figures) => number) => [cur(f(p)), cur(f(c))];
  y = section(doc, y, "Sales, collections and remittances");
  autoTable(doc, {
    startY: y,
    head: [["", "This period", "Cumulative to period end"]],
    body: [
      ["Number of invoices", String(p.sales.count), String(c.sales.count)],
      ["Total sales value", ...money((x) => x.sales.value)],
      ["   of which sold from marketer's stock", ...money((x) => x.sales.van_value)],
      ["   of which sold direct to their customers", ...money((x) => x.sales.direct_value)],
      ["Paid at the time of sale", ...money((x) => x.sales.paid_at_sale)],
      ["Customer advance applied", ...money((x) => x.sales.advance_applied)],
      ["Credit sales (left owing at sale)", ...money((x) => x.sales.credit_sales)],
      ["Customer payments received - total", ...money((x) => x.collections.total)],
      ["   cash", ...money((x) => x.collections.cash)],
      ["   transfer / POS / other", ...money((x) => x.collections.other)],
      ["   payments on earlier debts", ...money((x) => x.collections.on_debts)],
      [
        "Collected by marketer at sales (to remit)",
        ...money((x) => x.collections.held_by_marketer),
      ],
      ["Amount remitted to the factory", ...money((x) => x.remittances.total)],
    ],
    foot: [
      ["Unremitted collections at period end", "", cur(p.unremitted)],
      ["Customer debt outstanding (now)", "", cur(c.debt.outstanding)],
    ],
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: HEAD },
    footStyles: { fillColor: [241, 245, 249], textColor: 20 },
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
  });
  y = lastY(doc) + 18;

  y = section(doc, y, "Stock accountability by product (units, this period)");
  autoTable(doc, {
    startY: y,
    head: [
      [
        "Product",
        "Opening",
        "Issued",
        "Sold",
        "Returned",
        "Damaged",
        "Corr.",
        "Closing",
        "Invoiced qty",
        "Invoiced value",
      ],
    ],
    body: [
      ...p.products.map((r) => [
        `${r.name} (${r.unit})`,
        qty(r.opening),
        qty(r.issued),
        qty(r.sold),
        qty(r.returned),
        qty(r.damaged),
        qty(r.corrections),
        qty(r.closing),
        qty(r.qty_invoiced),
        cur(r.value_invoiced),
      ]),
    ],
    foot: [
      [
        "Total",
        qty(p.stock.opening),
        qty(p.stock.issued),
        qty(p.stock.sold),
        qty(p.stock.returned),
        qty(p.stock.damaged),
        qty(p.stock.corrections),
        qty(p.stock.closing),
        qty(p.products.reduce((t, r) => t + r.qty_invoiced, 0)),
        cur(p.sales.value),
      ],
    ],
    styles: { fontSize: 7, cellPadding: 2.5 },
    headStyles: { fillColor: HEAD },
    footStyles: { fillColor: [241, 245, 249], textColor: 20 },
    columnStyles: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => [i, { halign: "right" }]),
    ),
  });
  y = lastY(doc) + 8;
  doc.setFontSize(7);
  doc.text(
    `Issued value ${cur(p.stock.issued_value)} · returned value ${cur(p.stock.returned_value)}. Products sold on credit count as sold; the unpaid amount is customer debt, not unsold stock.`,
    40,
    y + 6,
    { maxWidth: doc.internal.pageSize.getWidth() - 80 },
  );
  y += 24;

  if (st.debtors.length) {
    y = section(doc, y, "Customers owing");
    autoTable(doc, {
      startY: y,
      head: [["Customer", "Phone", "Unpaid invoices", "Outstanding"]],
      body: st.debtors.map((d) => [
        d.customer,
        d.phone ?? "",
        String(d.invoices),
        cur(d.outstanding),
      ]),
      foot: [["Total", "", "", cur(st.debtors.reduce((t, d) => t + d.outstanding, 0))]],
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: HEAD },
      footStyles: { fillColor: [241, 245, 249], textColor: 20 },
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right" } },
    });
    y = lastY(doc) + 18;
  }

  const rec = st.reconciliation;
  const recRows: string[][] = [
    ...rec.pending_sales.map((s) => [
      "Sale awaiting approval",
      s.invoice,
      fmtDate(s.date),
      cur(Number(s.amount)),
    ]),
    ...rec.overdue_debts.map((s) => [
      `Overdue - ${s.customer}`,
      s.invoice ?? "",
      fmtDate(s.due),
      cur(Number(s.outstanding)),
    ]),
    ...rec.stock_drift.map((s) => [
      "Stock record mismatch",
      s.product,
      "",
      `${qty(Number(s.trail))} vs ${qty(Number(s.on_record))}`,
    ]),
  ];
  if (p.unremitted > 0.005)
    recRows.unshift(["Collections not yet remitted", "", "", cur(p.unremitted)]);
  y = section(doc, y, "Outstanding reconciliation items");
  autoTable(doc, {
    startY: y,
    head: [["Item", "Reference", "Date", "Amount"]],
    body: recRows.length ? recRows : [["None", "", "", ""]],
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: HEAD },
    columnStyles: { 3: { halign: "right" } },
  });

  finish(doc, `Marketer-Statement-${st.marketer.name.replace(/\s+/g, "-")}.pdf`, action);
}

// ------------------------------------------------------ customer statement ---

export async function generateCustomerAccountPdf(
  opts: { company: Company; statement: CustomerStatement; periodLabel: string; currency?: string },
  action: PdfAction = "download",
) {
  const cur = (v: number) => pdfMoney(v, opts.currency ?? "NGN");
  const st = opts.statement;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();

  let y = await letterhead(doc, opts.company, "CUSTOMER STATEMENT", [
    `Period: ${opts.periodLabel}`,
    st.marketer
      ? `Marketer: ${st.marketer.name}${st.marketer.code ? ` (${st.marketer.code})` : ""}`
      : "Marketer: unassigned",
  ]);

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(st.customer.name, 40, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const info = [st.customer.phone, st.customer.address].filter(Boolean).join(" · ");
  if (info) doc.text(info, 40, y + 12);
  const sums: [string, string][] = [
    ["Opening balance", cur(st.opening.debt)],
    ["Closing balance", cur(st.closing.debt)],
    ["Advance held", cur(st.closing.advance)],
  ];
  sums.forEach(([l, v], i) => {
    doc.setFont("helvetica", i === 1 ? "bold" : "normal");
    doc.text(l, pageW - 220, y + i * 12);
    doc.text(v, pageW - 40, y + i * 12, { align: "right" });
  });
  doc.setFont("helvetica", "normal");
  y += 44;

  // Account lines: every posting in date order, with the products on each sale.
  const body: string[][] = [];
  if (st.from)
    body.push([
      fmtDate(st.from),
      "",
      "Balance brought forward",
      "",
      "",
      "",
      "",
      "",
      cur(st.opening.debt),
    ]);
  for (const l of st.lines) {
    const items = l.items?.length
      ? l.items.map((i) => `${i.product} ${qty(i.quantity)} @ ${cur(i.unit_price)}`).join("\n")
      : "";
    const charged = lineCharged(l);
    const credited = lineCredited(l);
    body.push([
      fmtDate(l.date),
      l.invoice ?? l.receipt ?? "",
      `${l.description ?? l.type}${l.method && l.type !== "SALE" ? ` (${l.method})` : ""}${
        l.notes ? `\n${l.notes}` : ""
      }`,
      items,
      charged ? cur(charged) : "",
      credited ? cur(credited) : "",
      l.payment_date ? fmtDate(l.payment_date) : "",
      l.credit_delta ? cur(l.credit_delta) : "",
      cur(l.debt_after),
    ]);
  }
  body.push(["", "", "Closing balance", "", "", "", "", "", cur(st.closing.debt)]);

  autoTable(doc, {
    startY: y,
    head: [
      [
        "Date",
        "Invoice / receipt",
        "Description",
        "Products (qty @ price)",
        "Charged",
        "Paid / credited",
        "Paid on",
        "Advance +/-",
        "Balance",
      ],
    ],
    body,
    styles: { fontSize: 7, cellPadding: 2.5, valign: "top" },
    headStyles: { fillColor: HEAD },
    columnStyles: {
      3: { cellWidth: 160 },
      4: { halign: "right" },
      5: { halign: "right" },
      7: { halign: "right" },
      8: { halign: "right", fontStyle: "bold" },
    },
  });
  y = lastY(doc) + 18;

  // Invoice position: what each invoice was, what's been paid, what's left.
  const owing = st.invoices.filter((i) => i.in_period || i.outstanding > 0);
  y = section(doc, y, "Invoices");
  autoTable(doc, {
    startY: y,
    head: [
      [
        "Invoice",
        "Date",
        "Marketer",
        "Invoice value",
        "Paid",
        "Written off",
        "Outstanding",
        "Payments (receipt, date, amount)",
      ],
    ],
    body: owing.map((i) => [
      i.invoice_number,
      fmtDate(i.sale_date),
      i.marketer ?? "",
      cur(i.grand_total),
      cur(i.paid),
      i.written_off ? cur(i.written_off) : "",
      cur(i.outstanding),
      i.payments
        .map(
          (p) =>
            `${p.receipt ?? (p.kind === "advance" ? "advance" : "")} ${fmtDate(p.date)} ${cur(p.amount)}`,
        )
        .join("\n"),
    ]),
    foot: [
      [
        "Total",
        "",
        "",
        cur(owing.reduce((t, i) => t + i.grand_total, 0)),
        cur(owing.reduce((t, i) => t + i.paid, 0)),
        "",
        cur(owing.reduce((t, i) => t + i.outstanding, 0)),
        "",
      ],
    ],
    styles: { fontSize: 7, cellPadding: 2.5, valign: "top" },
    headStyles: { fillColor: HEAD },
    footStyles: { fillColor: [241, 245, 249], textColor: 20 },
    columnStyles: {
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { cellWidth: 190 },
    },
  });
  y = lastY(doc) + 18;

  if (st.returns.length) {
    y = section(doc, y, "Goods returned");
    autoTable(doc, {
      startY: y,
      head: [["Return", "Date", "Invoice", "Product", "Qty", "Accepted", "Status"]],
      body: st.returns.map((r) => [
        r.return_number,
        fmtDate(r.date),
        r.invoice ?? "",
        r.product,
        qty(Number(r.quantity)),
        r.accepted == null ? "" : qty(Number(r.accepted)),
        r.status,
      ]),
      styles: { fontSize: 7, cellPadding: 2.5 },
      headStyles: { fillColor: HEAD },
    });
    y = lastY(doc) + 14;
  }

  doc.setFontSize(7);
  doc.text(
    "Each invoice shows the prices charged at the time of sale. Payments are applied to the invoices shown against them; any excess is held as the customer's advance.",
    40,
    Math.min(y, doc.internal.pageSize.getHeight() - 30),
    { maxWidth: pageW - 80 },
  );

  finish(doc, `Customer-Statement-${st.customer.name.replace(/\s+/g, "-")}.pdf`, action);
}

// ---------------------------------------------- consolidated customer list ---

export async function generateMarketerCustomersPdf(
  opts: {
    company: Company;
    marketer: string;
    rows: CustomerReportRow[];
    filterLabel: string;
    currency?: string;
  },
  action: PdfAction = "download",
) {
  const cur = (v: number) => pdfMoney(v, opts.currency ?? "NGN");
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const y = await letterhead(doc, opts.company, "MARKETER CUSTOMER REPORT", [
    `Marketer: ${opts.marketer}`,
    opts.filterLabel,
  ]);
  const t = opts.rows.reduce(
    (a, r) => ({ p: a.p + r.total_purchases, pd: a.pd + r.total_paid, o: a.o + r.outstanding }),
    { p: 0, pd: 0, o: 0 },
  );
  autoTable(doc, {
    startY: y,
    head: [
      [
        "Customer",
        "Phone",
        "Status",
        "Invoices",
        "Total purchases",
        "Total paid",
        "Outstanding",
        "Overdue",
        "Last purchase",
      ],
    ],
    body: opts.rows.map((r) => [
      r.name,
      r.phone ?? "",
      r.status,
      String(r.invoices),
      cur(r.total_purchases),
      cur(r.total_paid),
      cur(r.outstanding),
      r.overdue ? cur(r.overdue) : "",
      fmtDate(r.last_purchase),
    ]),
    foot: [["Total", "", "", "", cur(t.p), cur(t.pd), cur(t.o), "", ""]],
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: HEAD },
    footStyles: { fillColor: [241, 245, 249], textColor: 20 },
    columnStyles: {
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right" },
    },
  });
  finish(doc, `Customers-${opts.marketer.replace(/\s+/g, "-")}.pdf`, action);
}

// Letterhead details from the factory settings row.
export function companyOf(
  s:
    | {
        company_name?: string | null;
        address?: string | null;
        phone?: string | null;
        logo_url?: string | null;
      }
    | null
    | undefined,
) {
  return {
    name: s?.company_name ?? "Elim Table Water",
    address: s?.address,
    phone: s?.phone,
    logo_url: s?.logo_url,
  };
}

// --------------------------------------------- credits / outstandings sheet ---

// One table per marketer (or for the distributors), laid out as the factory's
// "<MARKETER> TOTAL CREDIT OUTSTANDING" sheets: a title row, then each
// customer's name, total outstanding and phone, then the total.
export type OutstandingGroup = {
  title: string;
  rows: { customer: string; outstanding: number; phone: string | null }[];
};

export async function generateCreditOutstandingPdf(
  opts: {
    company: Company;
    heading: string;
    asAt: string;
    groups: OutstandingGroup[];
    currency?: string;
  },
  action: PdfAction = "print",
) {
  const amt = (v: number) =>
    new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      v,
    );
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
  const grand = opts.groups.reduce(
    (t, g) => t + g.rows.reduce((s, r) => s + Number(r.outstanding), 0),
    0,
  );
  let y = await letterhead(doc, opts.company, opts.heading, [
    `As at: ${opts.asAt}`,
    `${opts.groups.length} account(s) · Total ${pdfMoney(grand, opts.currency ?? "NGN")}`,
  ]);

  for (const g of opts.groups) {
    const total = g.rows.reduce((s, r) => s + Number(r.outstanding), 0);
    if (y > doc.internal.pageSize.getHeight() - 120) {
      doc.addPage();
      y = 48;
    }
    autoTable(doc, {
      startY: y,
      theme: "grid",
      head: [
        [
          {
            content: g.title,
            colSpan: 3,
            styles: {
              halign: "center",
              fontStyle: "bold",
              fontSize: 10,
              fillColor: [241, 245, 249],
            },
          },
        ],
        ["CUSTOMER'S NAME", "TOTAL OUTSTANDING", "PHONE NUMBER"],
      ],
      body: g.rows.map((r) => [
        r.customer.toUpperCase(),
        amt(Number(r.outstanding)),
        r.phone ?? "",
      ]),
      foot: [["TOTAL", amt(total), ""]],
      styles: {
        fontSize: 9,
        cellPadding: 4,
        textColor: [15, 23, 42],
        lineColor: [0, 0, 0],
        lineWidth: 0.5,
      },
      headStyles: { fillColor: [255, 255, 255], textColor: [30, 64, 175], fontStyle: "bold" },
      footStyles: { fillColor: [255, 255, 255], textColor: [15, 23, 42], fontStyle: "bold" },
      columnStyles: { 1: { halign: "right" } },
      didParseCell: (d) => {
        // The total figure stands out, as on the factory's sheets.
        if (d.section === "foot" && d.column.index === 1) d.cell.styles.fillColor = [253, 235, 200];
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  }
  finish(doc, `${opts.heading.replace(/\s+/g, "-")}.pdf`, action);
}
