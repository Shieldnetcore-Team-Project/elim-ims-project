// Run: npx tsx --test src/lib/marketer-sales-sheet.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSheetRows,
  marketerSheetRows,
  sheetDayLabel,
  sheetMonth,
  sheetTotals,
} from "./marketer-sales-sheet";

const day = (d: string, total: number, credit: number, recovery: number) => ({
  day: d,
  sales_value: total,
  credit_sales: credit,
  debt_collections: recovery,
});

test("cash = total − credit; remitted = cash + recovery (Courage, 1–2 Sep)", () => {
  const rows = buildSheetRows([
    day("2026-09-02", 1074100, 895250, 1051450),
    day("2026-09-01", 913000, 658000, 0),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.day, r.cash, r.recovery, r.remitted]),
    [
      ["2026-09-01", 255000, 0, 255000],
      ["2026-09-02", 178850, 1051450, 1230300],
    ],
  );
  assert.deepEqual(sheetTotals(rows), {
    total: 1987100,
    credit: 1553250,
    cash: 433850,
    recovery: 1051450,
    remitted: 1485300,
  });
});

test("quiet Sundays drop off; quiet weekdays and busy Sundays stay", () => {
  const rows = buildSheetRows([
    day("2026-09-04", 0, 0, 0), // Friday, nothing
    day("2026-09-06", 0, 0, 0), // Sunday, nothing
    day("2026-09-13", 0, 0, 5000), // Sunday, a recovery
  ]);
  assert.deepEqual(
    rows.map((r) => r.day),
    ["2026-09-04", "2026-09-13"],
  );
});

test("null money figures (no finance rights) read as zero", () => {
  const [r] = buildSheetRows([
    { day: "2026-09-01", sales_value: null, credit_sales: null, debt_collections: null },
  ]);
  assert.deepEqual([r.total, r.cash, r.remitted], [0, 0, 0]);
});

test("labels match the sheet", () => {
  assert.equal(sheetDayLabel("2026-09-01"), "Tuesday, September 01, 2026");
  const today = new Date(2026, 9, 22);
  assert.deepEqual(sheetMonth(2026, 8, today), {
    from: "2026-09-01",
    to: "2026-09-30",
    label: "SEP, 2026",
  });
  // The month in progress runs to today.
  assert.deepEqual(sheetMonth(2026, 9, today), {
    from: "2026-10-01",
    to: "2026-10-22",
    label: "OCT, 2026",
  });
});

test("flat rows: days then a TOTAL line per marketer", () => {
  const rows = buildSheetRows([day("2026-09-01", 100, 40, 10)]);
  const flat = marketerSheetRows([
    { repId: "r", code: "SR-01", name: "Courage", rows, totals: sheetTotals(rows) },
  ]);
  assert.deepEqual(
    flat.map((r) => [r.kind, r.marketer, r.date, r.cash, r.remitted]),
    [
      ["item", "Courage (SR-01)", "Tuesday, September 01, 2026", 60, 70],
      ["subtotal", "Courage (SR-01)", "TOTAL", 60, 70],
    ],
  );
});
