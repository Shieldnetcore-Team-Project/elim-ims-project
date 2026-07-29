export interface CsvColumn<T> { label: string; get: (row: T) => string | number }

// A cell starting = + - @ is executed by Excel on open; a customer named
// `=cmd|'/c calc'!A1` is a remote-code-execution vector in a customer master.
function escapeCell(v: string | number): string {
  const t = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function exportCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]) {
  const body = [columns.map(c => escapeCell(c.label)).join(',')]
    .concat(rows.map(r => columns.map(c => escapeCell(c.get(r))).join(','))).join('\r\n');

  // ﻿ (BOM) — without it, Excel reads UTF-8 as Windows-1252 and ₦ becomes â‚¦.
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
