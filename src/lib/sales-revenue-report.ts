import type { ReportColumn } from "./export";

// "Sales Revenue" (day by day, with the running total through the period) and
// "Monthly Accumulated Sales" (month by month for a year, with the
// year-to-date total). Revenue is the same set every dashboard counts: posted,
// non-deleted, non-PR invoices by sale date, valued at the invoice's grand
// total -- so these reports agree with the Sales Revenue / Total Sales cards.

export type RevenueSale = {
  sale_date: string;
  grand_total: number;
  amount_paid: number;
  balance: number;
};

export type RevenueLine = {
  key: string; // yyyy-MM-dd for a day, yyyy-MM for a month
  invoices: number;
  revenue: number;
  collected: number;
  outstanding: number;
  accumulated: number;
};

export type RevenueReport = {
  lines: RevenueLine[];
  invoices: number;
  revenue: number;
  collected: number;
  outstanding: number;
};

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const round2 = (v: number) => Math.round(v * 100) / 100;

// Buckets sales by `keyOf`, in key order, and carries the running total.
// `keys` lists buckets that must appear even with no sales (every month of
// the year), so the accumulated column reads straight down.
function accumulate(
  sales: RevenueSale[],
  keyOf: (s: RevenueSale) => string,
  keys: string[] = [],
): RevenueReport {
  const buckets = new Map<string, Omit<RevenueLine, "accumulated">>();
  const bucket = (key: string) => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, invoices: 0, revenue: 0, collected: 0, outstanding: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  keys.forEach(bucket);
  for (const s of sales) {
    const b = bucket(keyOf(s));
    b.invoices += 1;
    b.revenue += Number(s.grand_total ?? 0);
    b.collected += Number(s.amount_paid ?? 0);
    b.outstanding += Number(s.balance ?? 0);
  }
  let running = 0;
  const lines = [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => {
      running += b.revenue;
      return {
        ...b,
        revenue: round2(b.revenue),
        collected: round2(b.collected),
        outstanding: round2(b.outstanding),
        accumulated: round2(running),
      };
    });
  return {
    lines,
    invoices: lines.reduce((n, l) => n + l.invoices, 0),
    revenue: round2(running),
    collected: round2(lines.reduce((n, l) => n + l.collected, 0)),
    outstanding: round2(lines.reduce((n, l) => n + l.outstanding, 0)),
  };
}

export const buildDailyRevenue = (sales: RevenueSale[]) =>
  accumulate(sales, (s) => s.sale_date.slice(0, 10));

// Every month of `year` up to `lastMonth` (0-based; the current month for
// this year, December for a past one), empty months included.
export const buildMonthlyAccumulated = (sales: RevenueSale[], year: number, lastMonth = 11) =>
  accumulate(
    sales.filter((s) => s.sale_date.startsWith(`${year}-`)),
    (s) => s.sale_date.slice(0, 7),
    Array.from({ length: lastMonth + 1 }, (_, m) => `${year}-${String(m + 1).padStart(2, "0")}`),
  );

export const monthLabel = (key: string) =>
  `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

export const SALES_REVENUE_COLUMNS: ReportColumn[] = [
  { key: "period", label: "Date" },
  { key: "invoices", label: "Invoices" },
  { key: "revenue", label: "Revenue" },
  { key: "collected", label: "Collected" },
  { key: "outstanding", label: "Outstanding" },
  { key: "accumulated", label: "Accumulated" },
];

export const MONTHLY_ACCUMULATED_COLUMNS: ReportColumn[] = [
  { key: "period", label: "Month" },
  { key: "invoices", label: "Invoices" },
  { key: "revenue", label: "Month Sales" },
  { key: "collected", label: "Collected" },
  { key: "outstanding", label: "Outstanding" },
  { key: "accumulated", label: "Accumulated (Year to Date)" },
];

// Flat rows for the table, CSV, Excel and PDF, with a total line (`kind`
// styles it) whose accumulated figure is the period's revenue.
export function revenueRows(
  report: RevenueReport,
  label: (key: string) => string,
): Record<string, unknown>[] {
  if (report.lines.length === 0) return [];
  return [
    ...report.lines.map((l) => ({ kind: "item", ...l, period: label(l.key) })),
    {
      kind: "total",
      period: "TOTAL",
      invoices: report.invoices,
      revenue: report.revenue,
      collected: report.collected,
      outstanding: report.outstanding,
      accumulated: report.revenue,
    },
  ];
}

// Columns to ask postedSalesRows (metric-queries.ts) for. The rows are fetched
// by the caller so this file stays free of the Supabase client and testable.
export const REVENUE_SALE_COLS = "sale_date,grand_total,amount_paid,balance";

// The last month a year's report runs to: this month for the current year,
// December for a past one.
export const lastMonthOf = (year: number, now = new Date()) =>
  year === now.getFullYear() ? now.getMonth() : 11;

// Month-on-month change as a percentage, or null when there's nothing to
// compare against (no prior month, or a prior month with no sales).
export const changeVsPrior = (current: number, prior: number | undefined) =>
  prior ? ((current - prior) / prior) * 100 : null;
