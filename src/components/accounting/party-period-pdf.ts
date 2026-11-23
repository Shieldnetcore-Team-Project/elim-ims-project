import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  drawLetterhead,
  finishPdf,
  letterheadPageNumbers,
  letterheadPrintedBy,
  letterheadSection,
  letterheadTable,
  type CompanyLike,
  type PdfAction,
} from "@/lib/pdf";

// One customer's account for the dates picked, on the letterhead (user,
// 2026-11-23): per product posted / returned / net, then every posting and
// return in the period, oldest first, with its products and value.

export type PeriodLine = {
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
};
export type PeriodGroup = {
  kind: "posting" | "return";
  reference: string;
  day: string;
  at: string;
  status: string;
  lines: PeriodLine[];
  value: number;
};

const q = (v: number) => v.toLocaleString("en-US");
const amt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d: string) => d.split("-").reverse().join("/");

export async function partyPeriodPdf(
  opts: {
    company: CompanyLike;
    party: string;
    from: string;
    to: string;
    totals: [string, { unit: string; posted: number; returned: number }][];
    groups: PeriodGroup[];
    showValues: boolean;
  },
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const period = opts.from
    ? `For the Period ${dmy(opts.from)} to ${dmy(opts.to || opts.from)}`
    : "All dates";
  const y = await drawLetterhead(doc, opts.company, `Account Statement — ${opts.party}`, [period]);

  autoTable(doc, {
    ...letterheadTable(9.5),
    startY: y,
    head: [["Product", "Unit", "Posted", "Returned", "Net"]],
    body: opts.totals.map(([name, t]) => [
      name,
      t.unit,
      q(t.posted),
      q(t.returned),
      q(t.posted - t.returned),
    ]),
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } },
  });

  const groups = [...opts.groups].sort((a, b) => a.at.localeCompare(b.at));
  let posted = 0;
  let returned = 0;
  const body = groups.map((g, i) => {
    const live = g.status !== "reversed";
    if (live && g.kind === "posting") posted += g.value;
    if (live && g.kind === "return") returned += g.value;
    const items = g.lines
      .map(
        (l) =>
          `${l.product_name} x ${q(Number(l.quantity))} ${l.unit}` +
          (opts.showValues && l.unit_price != null ? ` @ ${amt(Number(l.unit_price))}` : ""),
      )
      .join("\n");
    const row = [
      String(i + 1),
      dmy(g.day),
      g.reference,
      g.kind === "posting" ? "Posting" : "Return",
      g.status.replace(/_/g, " "),
      items,
    ];
    if (opts.showValues) row.push((g.kind === "return" ? "-" : "") + amt(g.value));
    return row;
  });
  const head = ["S/N", "Date", "Reference", "Type", "Status", "Products"];
  if (opts.showValues) head.push("Amount");
  const foot = opts.showValues
    ? [
        ["", "", "", "", "", "Total posted", amt(posted)],
        ["", "", "", "", "", "Total returned", `-${amt(returned)}`],
        ["", "", "", "", "", "Net", amt(posted - returned)],
      ]
    : undefined;

  const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
  let sy = (last?.finalY ?? y) + 22;
  if (sy > doc.internal.pageSize.getHeight() - 80) {
    doc.addPage();
    sy = 44;
  }
  autoTable(doc, {
    ...letterheadTable(9),
    startY: letterheadSection(doc, "Postings and returns", sy),
    head: [head],
    body,
    foot,
    showFoot: "lastPage",
    columnStyles: {
      0: { cellWidth: 30 },
      1: { cellWidth: 64 },
      2: { cellWidth: 120 },
      3: { cellWidth: 52 },
      4: { cellWidth: 60 },
      6: { halign: "right", cellWidth: 90 },
    },
    didParseCell: (d) => {
      if (d.section === "foot" && d.column.index === 6) d.cell.styles.halign = "right";
      if (d.section === "foot" && d.column.index === 5) d.cell.styles.halign = "right";
    },
  });

  letterheadPrintedBy(doc, null);
  letterheadPageNumbers(doc);
  finishPdf(
    doc,
    `${opts.party}-statement-${opts.from || "all"}${opts.to ? `-${opts.to}` : ""}`,
    action,
  );
}
