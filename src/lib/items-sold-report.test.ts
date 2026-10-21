// Run: npx tsx --test src/lib/items-sold-report.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildItemsSold, itemsSoldRows, type ItemsSoldLine } from "./items-sold-report";

const line = (over: Partial<ItemsSoldLine>): ItemsSoldLine => ({
  customer_id: null,
  customer_code: null,
  customer_name: null,
  product: "Elim 50cl",
  unit: "pack",
  quantity: 1,
  amount: 100,
  ...over,
});

test("lines for the same customer and product add up; subtotals and grand total match", () => {
  const r = buildItemsSold([
    line({
      customer_id: "c1",
      customer_code: "DST-0002",
      customer_name: "Abacha",
      quantity: 300,
      amount: 795000,
    }),
    line({
      customer_id: "c1",
      customer_code: "DST-0002",
      customer_name: "Abacha",
      quantity: 217,
      amount: 575050,
    }),
    line({
      customer_id: "c1",
      customer_code: "DST-0002",
      customer_name: "Abacha",
      product: "Elim 75cl",
      quantity: 533,
      amount: 906100,
    }),
    line({
      customer_id: "c2",
      customer_code: "DST-0001",
      customer_name: "Nafdac",
      product: "Jug Refill",
      quantity: 41,
      amount: 49200,
    }),
  ]);
  assert.deepEqual(
    r.groups.map((g) => [g.code, g.name, g.quantity, g.amount]),
    [
      ["DST-0001", "Nafdac", 41, 49200],
      ["DST-0002", "Abacha", 1050, 2276150],
    ],
  );
  assert.deepEqual(
    r.groups[1].items.map((i) => [i.product, i.quantity, i.amount]),
    [
      ["Elim 50cl", 517, 1370050],
      ["Elim 75cl", 533, 906100],
    ],
  );
  assert.equal(r.quantity, 1091);
  assert.equal(r.amount, 2325350);
});

test("walk-ins group by name regardless of case/spacing, after customers with an ID", () => {
  const r = buildItemsSold([
    line({ customer_name: "sunday  obelle" }),
    line({ customer_name: "Sunday Obelle" }),
    line({ customer_name: "" }),
    line({ customer_id: "c9", customer_code: "DST-0010", customer_name: "Unique A&A" }),
  ]);
  assert.deepEqual(
    r.groups.map((g) => [g.name, g.quantity]),
    [
      ["Unique A&A", 1],
      ["sunday  obelle", 2],
      ["Walk-in customer", 1],
    ],
  );
});

test("customer IDs sort numerically", () => {
  const r = buildItemsSold([
    line({ customer_id: "a", customer_code: "DST-0010", customer_name: "A" }),
    line({ customer_id: "b", customer_code: "DST-0009", customer_name: "B" }),
  ]);
  assert.deepEqual(
    r.groups.map((g) => g.code),
    ["DST-0009", "DST-0010"],
  );
});

test("rows: ID and name on the first line only, then subtotal, then grand total", () => {
  const rows = itemsSoldRows(
    buildItemsSold([
      line({
        customer_id: "c1",
        customer_code: "DST-0001",
        customer_name: "Selda",
        product: "A",
        quantity: 100,
        amount: 110000,
      }),
      line({
        customer_id: "c1",
        customer_code: "DST-0001",
        customer_name: "Selda",
        product: "B",
        quantity: 50,
        amount: 80000,
      }),
    ]),
  );
  assert.deepEqual(
    rows.map((r) => [r.kind, r.customer_code, r.customer_name, r.quantity, r.amount]),
    [
      ["item", "DST-0001", "Selda", 100, 110000],
      ["item", "", "", 50, 80000],
      ["subtotal", "", "", 150, 190000],
      ["total", "", "", 150, 190000],
    ],
  );
  assert.deepEqual(itemsSoldRows(buildItemsSold([])), []);
});

test("a marketer's sales group under the marketer, whoever the end customer was", () => {
  const courage = { id: "r1", code: "SR-01", name: "Courage" };
  const r = buildItemsSold([
    line({ marketer: courage, customer_name: "Mama Ngozi", quantity: 10, amount: 1000 }),
    line({
      marketer: courage,
      customer_id: "c5",
      customer_code: "DST-0005",
      customer_name: "Bwari Store",
      quantity: 5,
      amount: 500,
    }),
    line({
      customer_id: "c5",
      customer_code: "DST-0005",
      customer_name: "Bwari Store",
      quantity: 2,
      amount: 200,
    }),
  ]);
  assert.deepEqual(
    r.groups.map((g) => [g.code, g.name, g.quantity, g.amount]),
    [
      ["DST-0005", "Bwari Store", 2, 200],
      ["SR-01", "Courage", 15, 1500],
    ],
  );
});
