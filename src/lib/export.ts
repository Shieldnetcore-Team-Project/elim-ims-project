export type ReportColumn = { key: string; label: string };

function downloadBlob(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Spreadsheets run a cell that starts with = + - @ as a formula. Names, reasons
// and remarks are typed by users, so text like =HYPERLINK("http://…") would
// execute when a report is opened. Prefix such text with an apostrophe so it
// stays text; real numbers (including negatives) and plain numeric strings are
// left exactly as they were.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (typeof value === "string" && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(
  filename: string,
  columns: ReportColumn[],
  rows: Record<string, unknown>[],
) {
  const lines = [
    columns.map((c) => csvCell(c.label)).join(","),
    ...rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(",")),
  ];
  downloadBlob(
    filename.endsWith(".csv") ? filename : `${filename}.csv`,
    lines.join("\n"),
    "text/csv;charset=utf-8;",
  );
}

function escapeHtml(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Excel opens an HTML table saved with an .xls extension natively — this avoids
// pulling in a real xlsx-writer dependency (the popular `xlsx` package on npm has
// unpatched high-severity CVEs) while still giving a genuine spreadsheet export.
export function exportExcel(
  filename: string,
  columns: ReportColumn[],
  rows: Record<string, unknown>[],
) {
  const head = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(r[c.key])}</td>`).join("")}</tr>`)
    .join("");
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">
    <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
    <x:Name>Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
    </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
    </head><body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
  downloadBlob(
    filename.endsWith(".xls") ? filename : `${filename}.xls`,
    html,
    "application/vnd.ms-excel",
  );
}
