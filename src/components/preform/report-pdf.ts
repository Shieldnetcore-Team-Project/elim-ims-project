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

// A4 landscape table report for the Preform Production page, on the factory
// letterhead like every report (user, 2026-11-17): the title, period and
// filters, a "pending records included" warning when there are any, the
// table, totals, any summary sections below it (each with its own heading --
// the summaries never replace the rows) and page numbers.

export type PdfColumn = { label: string; align?: "left" | "right" };
export type PdfSection = { title: string; columns: PdfColumn[]; rows: (string | number)[][] };

export async function preformReportPdf(
  opts: {
    company: string;
    // The factory's Settings row, for the letterhead's logo / address.
    settings?: CompanyLike;
    title: string;
    period: string;
    filters: string[];
    pendingNote?: string | null;
    columns: PdfColumn[];
    rows: (string | number)[][];
    totals?: (string | number)[] | null;
    sections?: PdfSection[];
    filename: string;
  },
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const M = 36;
  const y = await drawLetterhead(doc, opts.settings, opts.title, [
    `Period: ${opts.period}`,
    ...(opts.filters.length ? [opts.filters.join("   ·   ")] : []),
    ...(opts.pendingNote ? [opts.pendingNote] : []),
  ]);
  const fmt = (v: string | number) => (typeof v === "number" ? v.toLocaleString("en-US") : v);
  // Wide tables (the per-grammage report) use a smaller type to stay on A4.
  const size = (cols: number) => (cols > 18 ? 6 : cols > 10 ? 8 : 9.5);
  const table = (
    startY: number,
    columns: PdfColumn[],
    rows: (string | number)[][],
    totals?: (string | number)[] | null,
  ) => {
    const look = letterheadTable(size(columns.length));
    autoTable(doc, {
      ...look,
      styles: { ...look.styles, cellPadding: columns.length > 18 ? 2 : 3 },
      startY,
      head: [columns.map((c) => c.label)],
      body: rows.map((r) => r.map(fmt)),
      foot: totals ? [totals.map(fmt)] : undefined,
      showFoot: "lastPage",
      columnStyles: Object.fromEntries(
        columns.map((c, i) => [i, { halign: c.align === "right" ? "right" : "left" }]),
      ),
    });
  };
  table(y, opts.columns, opts.rows, opts.totals);
  for (const s of opts.sections ?? []) {
    if (!s.rows.length) continue;
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    let sy = (last?.finalY ?? y) + 22;
    if (sy > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      sy = M + 8;
    }
    table(letterheadSection(doc, s.title, sy), s.columns, s.rows);
  }
  letterheadPrintedBy(doc, null);
  letterheadPageNumbers(doc);
  finishPdf(doc, opts.filename, action);
}
