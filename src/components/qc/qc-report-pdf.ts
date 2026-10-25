import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { drawLogoHeader, type PdfAction } from "@/lib/pdf";

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
export type QcPdfReport = { title: string; columns: QcPdfColumn[]; rows: (string | number)[][] };

// The sheet's header blue and grid.
export const QC_BLUE: [number, number, number] = [31, 117, 188];

export async function qcLetterheadPdf(
  opts: { company: QcCompany; reports: QcPdfReport[]; filename: string },
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const W = doc.internal.pageSize.getWidth();
  const M = 36;
  const fmt = (v: string | number) => String(v);

  for (const [i, r] of opts.reports.entries()) {
    if (i > 0) doc.addPage();
    let y = await drawLogoHeader(doc, opts.company.logo_url, 22, 150, 58);
    doc.setFont("times", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(0, 0, 0);
    for (const line of [
      opts.company.address,
      `Tel: ${opts.company.phone}, Email: ${opts.company.email}`,
      `Website: ${opts.company.website}`,
    ]) {
      doc.text(line, W / 2, y, { align: "center" });
      y += 13;
    }
    y += 16;
    doc.setFontSize(12.5);
    doc.text(r.title.toUpperCase(), W / 2, y, { align: "center" });
    autoTable(doc, {
      startY: y + 14,
      margin: { left: M, right: M },
      head: [r.columns.map((c) => c.label)],
      body: r.rows.map((row) => row.map(fmt)),
      theme: "grid",
      styles: {
        font: "times",
        fontStyle: "bold",
        fontSize: 10,
        textColor: [0, 0, 0],
        lineColor: [40, 40, 40],
        lineWidth: 0.6,
        cellPadding: 3,
      },
      headStyles: { fillColor: QC_BLUE, textColor: [255, 255, 255], fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 34 } },
    });
  }

  if (action === "download") doc.save(`${opts.filename}.pdf`);
  else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
