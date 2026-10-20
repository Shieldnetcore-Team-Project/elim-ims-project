// Run: npx tsx --test src/lib/jug-accountability.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDay, parseDay, rowIsConsistent, totalRows, type JugRow } from "./jug-accountability";

const row = (over: Partial<JugRow & { report_date: string }>) => {
  const r = {
    report_date: "2026-10-20",
    opening: 0,
    loaded: 0,
    jug_water_sold: 0,
    refills_sold: 0,
    empties_sold: 0,
    empties_value: 0,
    returned: 0,
    pending_claims: 0,
    received: 0,
    written_off: 0,
    ...over,
  };
  const total = r.opening + r.loaded;
  const expected = total - r.jug_water_sold - r.empties_sold;
  return {
    ...r,
    total,
    expected_empties: expected,
    outstanding: expected - r.received - r.written_off,
  };
};

test("valid days pass, anything else is null (no 'Invalid date')", () => {
  assert.equal(parseDay("2026-10-20"), "2026-10-20");
  for (const bad of [
    "",
    null,
    undefined,
    "Invalid date",
    "2026-02-30",
    "20/10/2026",
    "2026-13-01",
    "1899-01-01",
  ])
    assert.equal(parseDay(bad as string), null, String(bad));
  assert.equal(formatDay("2026-10-20"), "20 Oct 2026");
  assert.equal(formatDay("Invalid date"), "—");
});

test("the factory's example: 49 + 50 = 99 and the server's formulas hold", () => {
  const r = row({
    opening: 49,
    loaded: 50,
    jug_water_sold: 5,
    empties_sold: 3,
    returned: 60,
    received: 58,
    written_off: 2,
  });
  assert.equal(r.total, 99);
  assert.equal(r.expected_empties, 91);
  assert.equal(r.outstanding, 31);
  assert.ok(rowIsConsistent(r));
  assert.ok(!rowIsConsistent({ ...r, outstanding: 29 }), "Returned is never subtracted");
});

test("totals add flows; opening is the first day's, outstanding the last day's", () => {
  const t = totalRows([
    row({ report_date: "2026-10-19", opening: 0, loaded: 49 }),
    row({ report_date: "2026-10-20", opening: 49, loaded: 50, jug_water_sold: 5, received: 58 }),
    row({ report_date: "2026-10-20", opening: 10, loaded: 0 }), // another marketer
    row({ report_date: "2026-10-19", opening: 10, loaded: 0 }),
  ]);
  assert.equal(t.opening, 10);
  assert.equal(t.loaded, 99);
  assert.equal(t.received, 58);
  assert.equal(t.outstanding, 49 + 50 - 5 - 58 + 10);
  assert.equal(t.expected_empties, t.total - t.jug_water_sold - t.empties_sold);
});
