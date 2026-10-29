import { addDays, format, parseISO } from "date-fns";
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

// ---------------------------------------------------------------------------
// Every party's sheet (Finance overview → Monthly accumulated sales): the same
// sheet for each marketer, the retail shop, each distributor, and walk-ins /
// other customers as one party, from monthly_party_sheet() -- which uses the
// same figures as marketer_daily_accountability().

export type PartyKind = "marketer" | "retail" | "distributor" | "other";

export const PARTY_KINDS: { kind: PartyKind; label: string; idLabel: string }[] = [
  { kind: "marketer", label: "Marketers", idLabel: "Marketer ID" },
  { kind: "retail", label: "Retail", idLabel: "Outlet ID" },
  { kind: "distributor", label: "Distributors", idLabel: "Distributor ID" },
  { kind: "other", label: "Walk-in & other customers", idLabel: "ID" },
];

export type PartySheet = MarketerSheet & { kind: PartyKind };

type PartyDayRow = {
  party_kind: PartyKind;
  party_id: string | null;
  party_code: string | null;
  party_name: string;
  day: string;
  total: number;
  credit: number;
  recovery: number;
};

// Sorted by kind (marketers, retail, distributors, others), then name. Each
// sheet runs over every day from..to; buildSheetRows drops quiet Sundays.
export async function fetchPartySheets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
  db: any,
  factoryId: string,
  from: string,
  to: string,
): Promise<PartySheet[]> {
  const { data, error } = await db.rpc("monthly_party_sheet", {
    p_factory: factoryId,
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  const days: string[] = [];
  for (let d = parseISO(from); format(d, "yyyy-MM-dd") <= to; d = addDays(d, 1))
    days.push(format(d, "yyyy-MM-dd"));
  const parties = new Map<string, { row: PartyDayRow; byDay: Map<string, PartyDayRow> }>();
  for (const r of (data ?? []) as PartyDayRow[]) {
    const key = `${r.party_kind}:${r.party_id ?? ""}`;
    if (!parties.has(key)) parties.set(key, { row: r, byDay: new Map() });
    parties.get(key)!.byDay.set(String(r.day).slice(0, 10), r);
  }
  const order = PARTY_KINDS.map((k) => k.kind);
  return [...parties.entries()]
    .map(([key, { row, byDay }]) => {
      const rows = buildSheetRows(
        days.map((day) => ({
          day,
          sales_value: Number(byDay.get(day)?.total ?? 0),
          credit_sales: Number(byDay.get(day)?.credit ?? 0),
          debt_collections: Number(byDay.get(day)?.recovery ?? 0),
        })),
      );
      return {
        repId: key,
        kind: row.party_kind,
        code: row.party_code,
        name: row.party_name,
        rows,
        totals: sheetTotals(rows),
      };
    })
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
}
