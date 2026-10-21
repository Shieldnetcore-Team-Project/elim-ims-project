import { format, parseISO } from "date-fns";
import type { ReportColumn } from "./export";

// Marketer daily sales sheet — the month-by-day sheet the office keeps per
// marketer ("COURAGE (SEP, 2026)"): one line per working day with total
// sales, the part sold on credit, the cash part, debts recovered that day,
// and the cash that should have come in (cash sales + recovery). Figures are
// marketer_daily_accountability()'s, the same as the marketer's Days tab.

export type SheetDayInput = {
  day: string; // yyyy-MM-dd
  sales_value: number | null;
  credit_sales: number | null;
  debt_collections: number | null;
};

export type SheetRow = {
  day: string;
  total: number;
  credit: number;
  cash: number;
  recovery: number;
  remitted: number;
};

export type MarketerSheet = {
  repId: string;
  code: string | null;
  name: string;
  rows: SheetRow[];
  totals: Omit<SheetRow, "day">;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

// Oldest day first. Sundays are left off unless something happened on one
// (the sheet lists working days only); other quiet days stay, as on the sheet.
export function buildSheetRows(days: SheetDayInput[]): SheetRow[] {
  return [...days]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => {
      const total = round2(Number(d.sales_value ?? 0));
      const credit = round2(Number(d.credit_sales ?? 0));
      const cash = round2(total - credit);
      const recovery = round2(Number(d.debt_collections ?? 0));
      return { day: d.day, total, credit, cash, recovery, remitted: round2(cash + recovery) };
    })
    .filter((r) => parseISO(r.day).getDay() !== 0 || r.total !== 0 || r.recovery !== 0);
}

export function sheetTotals(rows: SheetRow[]): Omit<SheetRow, "day"> {
  const sum = (k: keyof Omit<SheetRow, "day">) => round2(rows.reduce((s, r) => s + r[k], 0));
  return {
    total: sum("total"),
    credit: sum("credit"),
    cash: sum("cash"),
    recovery: sum("recovery"),
    remitted: sum("remitted"),
  };
}

export const sheetDayLabel = (day: string) => format(parseISO(day), "EEEE, MMMM dd, yyyy");

// The sheet covers one calendar month: "SEP, 2026" in the heading, and its days
// run to the month end — or to today, for the month still in progress.
export function sheetMonth(year: number, month: number, today = new Date()) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const to = last > today ? today : last;
  return {
    from: format(first, "yyyy-MM-dd"),
    to: format(to < first ? first : to, "yyyy-MM-dd"),
    label: format(first, "MMM, yyyy").toUpperCase(),
  };
}

export const MARKETER_SHEET_COLUMNS: ReportColumn[] = [
  { key: "marketer", label: "Marketer" },
  { key: "date", label: "Date" },
  { key: "total", label: "Total Sales" },
  { key: "credit", label: "Credit Sales" },
  { key: "cash", label: "Cash Sales" },
  { key: "recovery", label: "Recovery" },
  { key: "remitted", label: "Total Cash Remitted" },
];

// Flat rows for the screen, CSV and Excel: each marketer's days, then their TOTAL.
export function marketerSheetRows(sheets: MarketerSheet[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const s of sheets) {
    const marketer = s.code ? `${s.name} (${s.code})` : s.name;
    for (const r of s.rows) out.push({ kind: "item", marketer, date: sheetDayLabel(r.day), ...r });
    out.push({ kind: "subtotal", marketer, date: "TOTAL", ...s.totals });
  }
  return out;
}

// One sheet per marketer. `reps` are the marketers to include (retail outlets
// excluded by the caller); a marketer with nothing in the period is dropped
// when printing all of them, so the pile only holds marketers who traded.
export async function fetchMarketerSheets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
  db: any,
  reps: { id: string; code: string | null; full_name: string }[],
  from: string,
  to: string,
  keepEmpty: boolean,
): Promise<MarketerSheet[]> {
  const sheets = await Promise.all(
    reps.map(async (rep) => {
      const { data, error } = await db.rpc("marketer_daily_accountability", {
        p_rep: rep.id,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      const rows = buildSheetRows((data ?? []) as SheetDayInput[]);
      return {
        repId: rep.id,
        code: rep.code,
        name: rep.full_name,
        rows,
        totals: sheetTotals(rows),
      };
    }),
  );
  return sheets.filter((s) => keepEmpty || s.totals.total !== 0 || s.totals.recovery !== 0);
}
