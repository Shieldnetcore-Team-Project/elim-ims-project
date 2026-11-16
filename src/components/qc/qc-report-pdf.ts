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

// As printed on the factory's sheets when Settings has no details yet.
export const SHEET_DEFAULTS = {
  address:
    "Plot No. 188A, FCDA SchemeExtension III, Off Bwari/Dutse Road, By Power Station, Opp. KAS Guest House, Kubwa, FCT Abuja.",
  phone: "+2348166399794",
  email: "info@elimtablewater.com",
  website: "www.elimtablewater.com",
};

// The letterhead from the factory's Settings, falling back to the sheet.
export const sheetCompany = (
  s:
    | {
        logo_url?: string | null;
        address?: string | null;
        phone?: string | null;
        email?: string | null;
        website?: string | null;
      }
    | null
    | undefined,
): QcCompany => ({
  logo_url: s?.logo_url,
  address: s?.address || SHEET_DEFAULTS.address,
  phone: s?.phone || SHEET_DEFAULTS.phone,
  email: s?.email || SHEET_DEFAULTS.email,
  website: s?.website || SHEET_DEFAULTS.website,
});

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
    if (r.subtitle?.length) {
      doc.setFontSize(9.5);
      for (const line of r.subtitle)
        for (const part of doc.splitTextToSize(line, W - 2 * M) as string[]) {
          y += 13;
          doc.text(part, W / 2, y, { align: "center" });
        }
    }
    autoTable(doc, {
      startY: y + 14,
      margin: { left: M, right: M },
      head: [r.columns.map((c) => c.label)],
      body: r.rows.map((row) => row.map(fmt)),
      foot: r.foot ? [r.foot.map(fmt)] : undefined,
      showFoot: "lastPage",
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
      footStyles: { fillColor: [230, 236, 245], textColor: [0, 0, 0], fontStyle: "bold" },
      columnStyles: {
        ...Object.fromEntries(
          r.columns.flatMap((c, j) =>
            c.align === "right" ? [[j, { halign: "right" as const }]] : [],
          ),
        ),
        0: { cellWidth: 34 },
      },
    });
    if (r.printedBy) {
      const H = doc.internal.pageSize.getHeight();
      const py =
        (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;
      doc.setFont("times", "normal");
      doc.setFontSize(8.5);
      doc.text(
        `Printed by: ${r.printedBy} · ${new Date().toLocaleString()}`,
        M,
        Math.min(py, H - 16),
      );
    }
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

  if (action === "download") doc.save(`${opts.filename}.pdf`);
  else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}

// Every report on the Quality Control, Warehouse and Production pages prints
// on this letterhead (user, 2026-11-16: "this style of report for all report
// in the qc, warehouse and production page"). Takes the same keyed columns /
// rows the screens and Excel use; a last row labelled "Total" becomes the
// shaded totals row. Title prints as "<DEPARTMENT>: <TITLE>".
export type Department =
  "Quality Control Department" | "Warehouse Department" | "Production Department";

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
        .replace(/^(quality control|warehouse|production)\s*[—–-]\s*/i, "")
        .replace(/\s*[—–-]\s*(quality control|warehouse|production)$/i, "")}`;
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
