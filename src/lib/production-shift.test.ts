// Run: npx tsx --test src/lib/production-shift.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSunday, lastSunday } from "./production-shift";

test("isSunday: only Sundays, and no date is not a Sunday", () => {
  assert.equal(isSunday("2026-11-08"), true);
  assert.equal(isSunday("2026-11-09"), false);
  assert.equal(isSunday("2026-11-07"), false);
  assert.equal(isSunday(""), false);
});

test("lastSunday: Monday looks back one day, Sunday is today, across a month end", () => {
  assert.equal(lastSunday(new Date(2026, 10, 9, 8)), "2026-11-08");
  assert.equal(lastSunday(new Date(2026, 10, 8, 20)), "2026-11-08");
  assert.equal(lastSunday(new Date(2026, 10, 14, 8)), "2026-11-08");
  assert.equal(lastSunday(new Date(2026, 10, 2, 8)), "2026-11-01");
  assert.equal(lastSunday(new Date(2026, 11, 5, 8)), "2026-11-29");
});
