// Run: npx tsx --test src/lib/party-sales-report.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPartySales,
  partySalesTable,
  partySalesTitle,
  periodDays,
  productLabel,
  type PartySalesRow,
} from "./party-sales-report";

const product = (name: string): PartySalesRow => ({
  row_kind: "product",
  party_type: null,
  party_id: null,
  party_name: null,
  party_code: null,
  product_name: name,
  quantity: 0,
});
const party = (type: PartySalesRow["party_type"], id: string, name: string): PartySalesRow => ({
  row_kind: "party",
  party_type: type,
  party_id: id,
  party_name: name,
  party_code: null,
  product_name: null,
  quantity: 0,
});
const line = (
  type: PartySalesRow["party_type"],
  id: string,
  name: string,
  prod: string,
  qty: number,
): PartySalesRow => ({
  ...party(type, id, name),
  row_kind: "line",
  product_name: prod,
  quantity: qty,
});

const rows: PartySalesRow[] = [
  product("Sachet Water"),
  product("Bottle Water 50cl"),
  product("Bottle Water 75cl"),
  product("Dispenser Water"),
  product("Empty Jug"),
  party("marketer", "m1", "Michael"),
  party("marketer", "m2", "Abiodun"),
  party("distributor", "d1", "MTN"),
  party("retail", "r1", "Retail Shop"),
  party("direct", "direct", "Direct Sales"),
  line("marketer", "m1", "Michael", "Dispenser Water", 379),
  line("marketer", "m1", "Michael", "Bottle Water 75cl", 560),
  line("distributor", "d1", "MTN", "Dispenser Water", 240),
  line("direct", "direct", "Direct Sales", "Jug + Water", 2),
];

test("every product is a column (sheet order), every party a row (zeros kept)", () => {
  const r = buildPartySales(rows);
  assert.deepEqual(r.products, [
    "Dispenser Water",
    "Empty Jug",
    "Jug + Water",
    "Bottle Water 75cl",
    "Bottle Water 50cl",
    "Sachet Water",
  ]);
  assert.deepEqual(
    r.parties.map((p) => p.name),
    ["Abiodun", "Direct Sales", "Michael", "MTN", "Retail Shop"],
  );
  assert.equal(r.totals["Dispenser Water"], 619);
  assert.equal(r.parties.find((p) => p.name === "Abiodun")!.total, 0);
});

test("a group prints only its parties; hide-empty drops parties with nothing", () => {
  assert.deepEqual(
    buildPartySales(rows, "marketer").parties.map((p) => p.name),
    ["Abiodun", "Michael"],
  );
  assert.deepEqual(
    buildPartySales(rows, "marketer", true).parties.map((p) => p.name),
    ["Michael"],
  );
  const d = buildPartySales(rows, "distributor");
  assert.equal(d.totals["Dispenser Water"], 240);
});

test("table: S/N, party, sheet headings, Total last", () => {
  const t = partySalesTable(buildPartySales(rows, "marketer"));
  assert.deepEqual(
    t.columns.map((c) => c.label),
    [
      "S/N",
      "Marketer/Distributor",
      "Jug (H2O only)",
      "Jugs Only",
      "Jug + Water",
      "75CL",
      "50CL",
      "Sachet",
    ],
  );
  assert.equal(t.rows[1].party, "Michael");
  assert.equal(t.rows[1].sn, 2);
  assert.equal(t.rows[2].party, "Total");
  assert.equal(t.rows[2].p0, 379);
});

test("periods and title", () => {
  const pick = { day: "2026-11-19", year: 2026, month: 1, from: "2026-11-10", to: "2026-11-01" };
  assert.deepEqual(periodDays("weekly", pick), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(periodDays("monthly", pick), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodDays("yearly", pick), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(periodDays("custom", pick), { from: "2026-11-01", to: "2026-11-10" });
  assert.equal(
    partySalesTitle("weekly", "all", "2022-11-14", "2022-11-19"),
    "Operations: Weekly Sales Report from 2022-11-14 to 2022-11-19",
  );
  assert.equal(productLabel("Cup Water"), "Cup");
  assert.equal(productLabel("1.5Ltr Bottle Water"), "1.5Ltr");
  assert.equal(productLabel("1Ltr Bottle Water"), "1Ltr");
  const r = buildPartySales([
    product("Bottle Water 75cl"),
    product("1Ltr Bottle Water"),
    product("Sachet Water"),
    product("1.5Ltr Bottle Water"),
  ]);
  assert.deepEqual(r.products, [
    "1.5Ltr Bottle Water",
    "1Ltr Bottle Water",
    "Bottle Water 75cl",
    "Sachet Water",
  ]);
});
