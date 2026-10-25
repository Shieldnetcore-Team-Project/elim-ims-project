import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { PdfAction } from "@/lib/pdf";

// A4 landscape table report for the Preform Production page: company,
// report title, period and filters, a "pending records included" warning
// when there are any, the table, totals, any summary sections below it
// (each with its own heading -- the summaries never replace the rows) and a
// generated-at footer.

export type PdfColumn = { label: string; align?: "left" | "right" };
export type PdfSection = { title: string; columns: PdfColumn[]; rows: (string | number)[][] };

export function preformReportPdf(
  opts: {
    company: string;
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
  const W = doc.internal.pageSize.getWidth();
  const M = 32;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(opts.company, M, M + 8);
  doc.setFontSize(12);
  doc.text(opts.title, W - M, M + 8, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Period: ${opts.period}`, W - M, M + 22, { align: "right" });
  let y = M + 36;
  if (opts.filters.length) {
    doc.text(opts.filters.join("   ·   "), M, y);
    y += 12;
  }
  if (opts.pendingNote) {
    doc.setTextColor(180, 83, 9);
    doc.text(opts.pendingNote, M, y);
    doc.setTextColor(0, 0, 0);
    y += 12;
  }
  const fmt = (v: string | number) => (typeof v === "number" ? v.toLocaleString("en-US") : v);
  // Wide tables (the per-grammage report) use a smaller type to stay on A4.
  const size = (cols: number) => (cols > 18 ? 6 : 7.5);
  const footer = () => {
    const H = doc.internal.pageSize.getHeight();
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(`Generated ${new Date().toLocaleString()}`, M, H - 14);
    doc.text(`Page ${doc.getNumberOfPages()}`, W - M, H - 14, { align: "right" });
    doc.setTextColor(0, 0, 0);
  };
  const table = (
    startY: number,
    columns: PdfColumn[],
    rows: (string | number)[][],
    totals?: (string | number)[] | null,
  ) =>
    autoTable(doc, {
      startY,
      margin: { left: M, right: M },
      head: [columns.map((c) => c.label)],
      body: rows.map((r) => r.map(fmt)),
      foot: totals ? [totals.map(fmt)] : undefined,
      theme: "grid",
      styles: { fontSize: size(columns.length), cellPadding: columns.length > 18 ? 2 : 3 },
      headStyles: { fillColor: [30, 41, 59], fontSize: size(columns.length) },
      footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: "bold" },
      columnStyles: Object.fromEntries(
        columns.map((c, i) => [i, { halign: c.align === "right" ? "right" : "left" }]),
      ),
      didDrawPage: footer,
    });
  table(y + 4, opts.columns, opts.rows, opts.totals);
  for (const s of opts.sections ?? []) {
    if (!s.rows.length) continue;
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    let sy = (last?.finalY ?? y) + 22;
    if (sy > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      sy = M + 8;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(s.title, M, sy);
    doc.setFont("helvetica", "normal");
    table(sy + 6, s.columns, s.rows);
  }
  if (action === "download") doc.save(`${opts.filename}.pdf`);
  else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
