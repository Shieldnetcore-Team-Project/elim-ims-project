// Run: npx tsx --test src/lib/preform-units.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBags,
  formatGrams,
  formatPieces,
  formatWeight,
  piecesFromWeight,
  splitBags,
  toPieces,
} from "./preform-units";

test("40 bags of 1,152 = 46,080 pieces, and back", () => {
  assert.equal(toPieces(40, 0, 1152), 46080);
  assert.deepEqual(splitBags(46080, 1152), { bags: 40, pieces: 0 });
});

test("a remainder is kept, never rounded away", () => {
  assert.deepEqual(splitBags(46081, 1152), { bags: 40, pieces: 1 });
  assert.deepEqual(splitBags(1151, 1152), { bags: 0, pieces: 1151 });
  assert.equal(toPieces(2, 7, 1152), 2311);
  assert.equal(formatPieces(46081, 1152), "46,081 pcs (40 bags + 1 pc)");
});

test("display without a factor shows pieces only", () => {
  assert.equal(formatPieces(500, null), "500 pcs");
  assert.equal(splitBags(500, 0), null);
});

test("singular and plural", () => {
  assert.equal(formatBags({ bags: 1, pieces: 576 }), "1 bag + 576 pcs");
  assert.equal(formatBags({ bags: 3, pieces: 0 }), "3 bags");
});

test("negative balances (variances) split symmetrically", () => {
  assert.deepEqual(splitBags(-1153, 1152), { bags: -1, pieces: -1 });
});

test("grams per preform and total weight", () => {
  assert.equal(formatGrams(18), "18 g");
  assert.equal(formatGrams(18.5), "18.5 g");
  assert.equal(formatGrams(null), null);
  assert.equal(formatWeight(1152, 18), "20.74 kg");
  assert.equal(formatWeight(10, 18), "180 g");
  assert.equal(formatWeight(100, null), null);
});

test("pieces from a delivery weight", () => {
  assert.equal(piecesFromWeight(1_800_000, 18), 100000);
  assert.equal(piecesFromWeight(20_740, 18), 1152);
  assert.equal(piecesFromWeight(1000, null), 0);
  assert.equal(piecesFromWeight(null, 18), 0);
});
