// Pure helpers for Dispenser Production & Jug Accountability (no data
// access), unit tested in jug-accountability.test.ts. Every figure on the
// page comes from jug_accountability_report / jug_overview
// (supabase/migrations/20261020200000_jug_accountability.sql); these only
// validate dates, total rows and re-check the server's arithmetic.

// A calendar day as YYYY-MM-DD, or null when the value is empty or not a
// real date (2026-02-30, "", "Invalid date"...). Never throws.
export function parseDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  if (y < 2000 || y > 2100) return null;
  return value.trim();
}

// "20 Oct 2026" for a valid day, "—" otherwise -- never "Invalid date".
export function formatDay(value: string | null | undefined): string {
  const d = parseDay(value);
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type JugRow = {
  opening: number;
  loaded: number;
  total: number;
  jug_water_sold: number;
  refills_sold: number;
  empties_sold: number;
  empties_value: number;
  returned: number;
  pending_claims: number;
  expected_empties: number;
  received: number;
  written_off: number;
  outstanding: number;
};

// The formulas the server applies, for a consistency check on screen:
//   Total = Opening + Loaded
//   Expected Empties = Total - Jug + Water Sold - Empties Sold
//   Outstanding = Expected Empties - Received - Written off
// Returned (a claim) is deliberately not in any of them -- only the
// Warehouse's verified count (Received) settles jugs.
export function rowIsConsistent(r: JugRow): boolean {
  return (
    r.total === r.opening + r.loaded &&
    r.expected_empties === r.total - r.jug_water_sold - r.empties_sold &&
    r.outstanding === r.expected_empties - r.received - r.written_off
  );
}

const SUMMED = [
  "loaded",
  "jug_water_sold",
  "refills_sold",
  "empties_sold",
  "empties_value",
  "returned",
  "pending_claims",
  "received",
  "written_off",
] as const;

// Totals across rows. Flows (loaded, sold, received...) add up; balances
// (opening, outstanding) are only meaningful for one day, so they are summed
// per day: opening of the first day, outstanding of the last.
export function totalRows<T extends JugRow & { report_date: string }>(rows: T[]): JugRow {
  const t = Object.fromEntries(SUMMED.map((k) => [k, 0])) as Record<
    (typeof SUMMED)[number],
    number
  >;
  for (const r of rows) for (const k of SUMMED) t[k] += Number(r[k]) || 0;
  const days = [...new Set(rows.map((r) => r.report_date))].sort();
  const first = days[0];
  const last = days[days.length - 1];
  const opening = rows.filter((r) => r.report_date === first).reduce((s, r) => s + r.opening, 0);
  const outstanding = rows
    .filter((r) => r.report_date === last)
    .reduce((s, r) => s + r.outstanding, 0);
  const total = opening + t.loaded;
  return {
    ...t,
    opening,
    total,
    expected_empties: total - t.jug_water_sold - t.empties_sold,
    outstanding,
  };
}
