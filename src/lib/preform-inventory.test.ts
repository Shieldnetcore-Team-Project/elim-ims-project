// Run: npx tsx --test src/lib/preform-inventory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptPieces, stockStatus, summarize, type StockRow } from "./preform-inventory";

const row = (over: Partial<StockRow>): StockRow => ({
  unit: "Piece",
  active: true,
  pieces_per_bag: null,
  current_stock: 0,
  current_value: 0,
  reorder_level: 0,
  pending_receipt_count: 0,
  pending_receipt_qty: 0,
  issued_since_qty: 0,
  ...over,
});

test("74 bags at 1,428 pieces = 105,672 pieces", () => {
  assert.equal(receiptPieces("bags", 74, 0, null, 1428), 105672);
  assert.equal(receiptPieces("bags", 40, 420, null, 1152), 46500);
});

test("a piece-based receipt is not converted again", () => {
  assert.equal(receiptPieces("pieces", 74, 5, 500, 1428), 500);
});

test("bags without a bag size give nothing, not a guess", () => {
  assert.equal(receiptPieces("bags", 3, 10, null, null), 0);
});

test("stock status: negative, out, low, ok", () => {
  assert.equal(stockStatus({ current_stock: -5, reorder_level: 100 }), "negative");
  assert.equal(stockStatus({ current_stock: 0, reorder_level: 0 }), "out");
  assert.equal(stockStatus({ current_stock: 100, reorder_level: 100 }), "low");
  assert.equal(stockStatus({ current_stock: 101, reorder_level: 100 }), "ok");
  assert.equal(stockStatus({ current_stock: 5, reorder_level: 0 }), "ok");
});

test("summary adds pieces, counts full bags across bag sizes, skips inactive and non-piece units", () => {
  const s = summarize([
    row({
      pieces_per_bag: 1152,
      current_stock: 46500,
      current_value: 100,
      pending_receipt_count: 1,
      pending_receipt_qty: 1428,
    }),
    row({
      pieces_per_bag: 1428,
      current_stock: 105672,
      current_value: 200,
      issued_since_qty: 14300,
    }),
    row({ current_stock: 500, current_value: 5 }), // pieces, no bag size
    row({ unit: "Kilogram", current_stock: 30, current_value: 7 }),
    row({ active: false, pieces_per_bag: 1600, current_stock: 20800, current_value: 50 }),
  ]);
  assert.equal(s.activeSpecs, 4);
  assert.equal(s.totalPieces, 46500 + 105672 + 500);
  assert.equal(s.nonPieceSpecs, 1);
  assert.equal(s.fullBags, 40 + 74); // loose pieces are never rounded into a bag
  assert.equal(s.bagSizes, 2);
  assert.equal(s.pendingReceipts, 1);
  assert.equal(s.pendingReceiptPieces, 1428);
  assert.equal(s.issuedPieces, 14300);
  assert.equal(s.totalValue, 100 + 200 + 5 + 7);
});

test("a negative balance never adds to the totals", () => {
  const s = summarize([row({ pieces_per_bag: 1000, current_stock: -2500 })]);
  assert.equal(s.totalPieces, 0);
  assert.equal(s.fullBags, 0);
});
