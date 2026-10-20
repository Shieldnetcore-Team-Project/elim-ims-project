import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { PdfAction } from "@/lib/pdf";

// A4 landscape table report for the Preform Production page: company,
// report title, period and filters, a "pending records included" warning
// when there are any, the table, totals and a generated-at footer.

export type PdfColumn = { label: string; align?: "left" | "right" };

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
  autoTable(doc, {
    startY: y + 4,
    margin: { left: M, right: M },
    head: [opts.columns.map((c) => c.label)],
    body: opts.rows.map((r) => r.map(fmt)),
    foot: opts.totals ? [opts.totals.map(fmt)] : undefined,
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 3 },
    headStyles: { fillColor: [30, 41, 59], fontSize: 7.5 },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: "bold" },
    columnStyles: Object.fromEntries(
      opts.columns.map((c, i) => [i, { halign: c.align === "right" ? "right" : "left" }]),
    ),
    didDrawPage: () => {
      const H = doc.internal.pageSize.getHeight();
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(`Generated ${new Date().toLocaleString()}`, M, H - 14);
      doc.text(`Page ${doc.getNumberOfPages()}`, W - M, H - 14, { align: "right" });
      doc.setTextColor(0, 0, 0);
    },
  });
  if (action === "download") doc.save(`${opts.filename}.pdf`);
  else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
