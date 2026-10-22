// Run: npx tsx --test src/lib/sales-revenue-report.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyRevenue,
  changeVsPrior,
  buildMonthlyAccumulated,
  lastMonthOf,
  monthLabel,
  revenueRows,
  type RevenueSale,
} from "./sales-revenue-report";

const sale = (sale_date: string, grand_total: number, amount_paid = grand_total): RevenueSale => ({
  sale_date,
  grand_total,
  amount_paid,
  balance: grand_total - amount_paid,
});

test("daily revenue groups by day in date order and carries the running total", () => {
  const r = buildDailyRevenue([
    sale("2026-10-03", 500, 200),
    sale("2026-10-01", 1000),
    sale("2026-10-01", 250.5),
  ]);
  assert.deepEqual(
    r.lines.map((l) => [l.key, l.invoices, l.revenue, l.collected, l.outstanding, l.accumulated]),
    [
      ["2026-10-01", 2, 1250.5, 1250.5, 0, 1250.5],
      ["2026-10-03", 1, 500, 200, 300, 1750.5],
    ],
  );
  assert.equal(r.revenue, 1750.5);
  assert.equal(r.invoices, 3);
  assert.equal(r.outstanding, 300);
});

test("monthly accumulated lists every month up to the last one, empty months included", () => {
  const r = buildMonthlyAccumulated(
    [
      sale("2026-01-15", 100),
      sale("2026-03-02", 300),
      sale("2026-03-30", 50),
      sale("2025-12-31", 9999), // other year: ignored
    ],
    2026,
    3,
  );
  assert.deepEqual(
    r.lines.map((l) => [l.key, l.revenue, l.accumulated]),
    [
      ["2026-01", 100, 100],
      ["2026-02", 0, 100],
      ["2026-03", 350, 450],
      ["2026-04", 0, 450],
    ],
  );
  assert.equal(r.revenue, 450);
});

test("rows end with a total line; no sales means no rows", () => {
  const rows = revenueRows(buildMonthlyAccumulated([sale("2026-02-01", 10)], 2026, 1), monthLabel);
  assert.equal(rows[0].period, "January 2026");
  assert.deepEqual(rows.at(-1), {
    kind: "total",
    period: "TOTAL",
    invoices: 1,
    revenue: 10,
    collected: 10,
    outstanding: 0,
    accumulated: 10,
  });
  assert.deepEqual(
    revenueRows(buildDailyRevenue([]), (k) => k),
    [],
  );
});

test("current year runs to this month, a past year to December", () => {
  const now = new Date(2026, 9, 22);
  assert.equal(lastMonthOf(2026, now), 9);
  assert.equal(lastMonthOf(2025, now), 11);
});

test("change vs prior month is a percentage, or null with nothing to compare", () => {
  assert.equal(changeVsPrior(150, 100), 50);
  assert.equal(changeVsPrior(50, 100), -50);
  assert.equal(changeVsPrior(100, 0), null);
  assert.equal(changeVsPrior(100, undefined), null);
});
