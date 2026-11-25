import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  LETTERHEAD_BLUE,
  drawLetterhead,
  finishPdf,
  letterheadPrintedBy,
  letterheadTable,
  sheetCompany,
  type PdfAction,
} from "@/lib/pdf";

// Quality Control's printed reports, laid out as the factory's own sheets:
// the logo centred, the address, Tel / Email and Website lines, the report
// title in capitals, then the table under a blue header row. A4 landscape,
// one page (or more) per report.

export type QcCompany = {
  logo_url?: string | null;
  address: string;
  phone: string;
  email: string;
  website: string;
};
export type QcPdfColumn = { label: string; align?: "left" | "right" };
// foot: a totals row under the table; summary: "Label: value" lines under a
// "Summary:" heading after it.
export type QcPdfReport = {
  title: string;
  columns: QcPdfColumn[];
  rows: (string | number)[][];
  foot?: (string | number)[];
  summary?: [string, string | number][];
  // Small centred lines under the title (period, notes).
  subtitle?: string[];
  // "Printed by: ..." in small type under the table.
  printedBy?: string | null;
};

// The letterhead itself lives in @/lib/pdf, shared by every report print.
export { SHEET_DEFAULTS, sheetCompany } from "@/lib/pdf";
export const QC_BLUE = LETTERHEAD_BLUE;

export async function qcLetterheadPdf(
  opts: { company: QcCompany; reports: QcPdfReport[]; filename: string },
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const M = 36;
  const fmt = (v: string | number) => String(v);

  for (const [i, r] of opts.reports.entries()) {
    if (i > 0) doc.addPage();
    const y = await drawLetterhead(doc, opts.company, r.title, r.subtitle);
    const numbered = /^(s\/?n|#|no\.?)$/i.test(r.columns[0]?.label ?? "");
    autoTable(doc, {
      ...letterheadTable(r.columns.length > 10 ? 8.5 : 10),
      startY: y,
      head: [r.columns.map((c) => c.label)],
      body: r.rows.map((row) => row.map(fmt)),
      foot: r.foot ? [r.foot.map(fmt)] : undefined,
      showFoot: "lastPage",
      columnStyles: {
        ...Object.fromEntries(
          r.columns.flatMap((c, j) =>
            c.align === "right" ? [[j, { halign: "right" as const }]] : [],
          ),
        ),
        ...(numbered ? { 0: { cellWidth: 34 } } : {}),
      },
    });
    if (r.printedBy) letterheadPrintedBy(doc, r.printedBy);
    if (r.summary?.length) {
      const H = doc.internal.pageSize.getHeight();
      let sy =
        (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY +
        (r.printedBy ? 36 : 24);
      if (sy + 16 * (r.summary.length + 1) > H - M) {
        doc.addPage();
        sy = M + 10;
      }
      doc.setFont("times", "bold");
      doc.setFontSize(13);
      doc.text("Summary:", M, sy);
      doc.setFontSize(10.5);
      for (const [label, value] of r.summary) {
        sy += 16;
        doc.text(`${label}:`, M, sy);
        doc.text(fmt(value), M + 190, sy);
      }
    }
  }

  finishPdf(doc, opts.filename, action);
}

// Department reports print on this letterhead. Takes the same keyed columns /
// rows the screens and Excel use; a last row labelled "Total" becomes the
// shaded totals row. Title prints as "<DEPARTMENT>: <TITLE>".
export type Department =
  | "Quality Control Department"
  | "Warehouse Department"
  | "Production Department"
  | "Store Department"
  | "Maintenance Department";

export function letterheadReportPdf(
  opts: {
    department: Department;
    title: string;
    columns: { key: string; label: string }[];
    rows: Record<string, unknown>[];
    subtitle?: string[];
    settings?: Parameters<typeof sheetCompany>[0];
    printedBy?: string | null;
    filename: string;
  },
  action: PdfAction = "print",
) {
  const cell = (v: unknown) => (v == null || v === "" ? "" : String(v));
  const asRow = (r: Record<string, unknown>) => opts.columns.map((c) => cell(r[c.key]));
  const last = opts.rows[opts.rows.length - 1];
  const isTotal =
    !!last && opts.rows.length > 1 && opts.columns.some((c) => cell(last[c.key]) === "Total");
  const body = isTotal ? opts.rows.slice(0, -1) : opts.rows;
  const title = /department/i.test(opts.title)
    ? opts.title
    : `${opts.department}: ${opts.title
        .replace(/^(quality control|warehouse|production|store|maintenance)\s*[—–-]\s*/i, "")
        .replace(/\s*[—–-]\s*(quality control|warehouse|production|store|maintenance)$/i, "")}`;
  return qcLetterheadPdf(
    {
      company: sheetCompany(opts.settings),
      filename: opts.filename,
      reports: [
        {
          title,
          columns: opts.columns.map((c) => ({ label: c.label })),
          rows: body.map(asRow),
          foot: isTotal ? asRow(last) : undefined,
          subtitle: opts.subtitle,
          printedBy: opts.printedBy,
        },
      ],
    },
    action,
  );
}
