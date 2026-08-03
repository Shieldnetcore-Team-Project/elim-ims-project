export type DateRangePreset = 'ALL' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | 'CUSTOM';
export interface DateRange { from: string; to: string }

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** null means "no filter" — used for the ALL preset and an incomplete Custom range. */
export function presetRange(preset: DateRangePreset, customFrom?: string, customTo?: string): DateRange | null {
  if (preset === 'ALL') return null;
  if (preset === 'CUSTOM') return customFrom && customTo ? { from: customFrom, to: customTo } : null;

  const to = new Date();
  const from = new Date(to);
  if (preset === 'WEEKLY') from.setDate(from.getDate() - 7);
  else if (preset === 'MONTHLY') from.setMonth(from.getMonth() - 1);
  else if (preset === 'QUARTERLY') from.setMonth(from.getMonth() - 3);
  else if (preset === 'YEARLY') from.setFullYear(from.getFullYear() - 1);
  // DAILY: from === to, today only.
  return { from: toDateStr(from), to: toDateStr(to) };
}

export function inRange(dateStr: string, range: DateRange | null): boolean {
  if (!range) return true;
  const d = dateStr.slice(0, 10);
  return d >= range.from && d <= range.to;
}

interface ExportColumn<T> { label: string; get: (row: T) => string | number }

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** SpreadsheetML — a plain XML file Excel opens natively as a real workbook
 *  when saved with a .xls extension. No PDF/xlsx library needed for this. */
export function toExcelXML<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const cell = (v: string | number) => {
    const isNum = typeof v === 'number';
    return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeXml(String(v))}</Data></Cell>`;
  };
  const headerRow = `<Row>${columns.map(c => cell(c.label)).join('')}</Row>`;
  const dataRows = rows.map(r => `<Row>${columns.map(c => cell(c.get(r))).join('')}</Row>`).join('');
  return `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n <Worksheet ss:Name="Report">\n  <Table>\n   ${headerRow}\n   ${dataRows}\n  </Table>\n </Worksheet>\n</Workbook>`;
}

export function downloadText(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

let styleEl: HTMLStyleElement | null = null;
/** @page rules apply to the whole print job, not a scoped element — this is
 *  the one dynamically-injected global toggle for the whole document. */
export function setPrintOrientation(orientation: 'portrait' | 'landscape') {
  if (!styleEl) {
    styleEl = document.createElement('style');
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `@page { size: A4 ${orientation}; }`;
}
