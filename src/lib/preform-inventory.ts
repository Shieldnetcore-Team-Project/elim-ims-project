import { splitBags } from "./preform-units";

// Pure helpers for Store → Preform Inventory (no data access), kept apart
// from the page's data layer so they can be unit tested
// (preform-inventory.test.ts). Stock is in pieces; bags are display only.

// The overview fields these helpers read.
export type StockRow = {
  unit: string;
  active: boolean;
  pieces_per_bag: number | null;
  current_stock: number;
  current_value: number;
  reorder_level: number;
  pending_receipt_count: number;
  pending_receipt_qty: number;
  issued_since_qty: number;
};

const PIECE_UNIT = /^\s*(piece|pieces|pcs|pc)\s*$/i;
export const isPieceUnit = (unit: string | null | undefined) => PIECE_UNIT.test(unit ?? "");

export type StockStatus = "negative" | "out" | "low" | "ok";

export function stockStatus(r: Pick<StockRow, "current_stock" | "reorder_level">): StockStatus {
  if (r.current_stock < 0) return "negative";
  if (r.current_stock === 0) return "out";
  if (r.reorder_level > 0 && r.current_stock <= r.reorder_level) return "low";
  return "ok";
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  negative: "Negative — reconcile",
  out: "Out of stock",
  low: "Below reorder level",
  ok: "OK",
};

export type InventorySummary = {
  activeSpecs: number;
  // Pieces of active preforms counted in pieces -- adding pieces of
  // different preforms is meaningful; adding other units is not.
  totalPieces: number;
  // Specs left out of totalPieces because their unit is not pieces.
  nonPieceSpecs: number;
  // Full bags summed across specs with different bag sizes: a count of bags
  // on the shelf, not a quantity -- labelled as such on screen.
  fullBags: number;
  bagSizes: number;
  pendingReceipts: number;
  pendingReceiptPieces: number;
  issuedPieces: number;
  totalValue: number;
};

export function summarize(rows: StockRow[]): InventorySummary {
  const active = rows.filter((r) => r.active);
  const pieceRows = active.filter((r) => isPieceUnit(r.unit));
  const bagged = pieceRows.filter((r) => r.pieces_per_bag);
  return {
    activeSpecs: active.length,
    totalPieces: pieceRows.reduce((s, r) => s + Math.max(r.current_stock, 0), 0),
    nonPieceSpecs: active.length - pieceRows.length,
    fullBags: bagged.reduce(
      (s, r) => s + Math.max(splitBags(r.current_stock, r.pieces_per_bag)?.bags ?? 0, 0),
      0,
    ),
    bagSizes: new Set(bagged.map((r) => r.pieces_per_bag)).size,
    pendingReceipts: rows.reduce((s, r) => s + r.pending_receipt_count, 0),
    pendingReceiptPieces: rows.reduce((s, r) => s + r.pending_receipt_qty, 0),
    issuedPieces: rows.reduce((s, r) => s + r.issued_since_qty, 0),
    totalValue: active.reduce((s, r) => s + r.current_value, 0),
  };
}

// Pieces from a bag entry. Bags must be whole; the remainder is loose pieces.
export function receiptPieces(
  mode: "bags" | "pieces",
  bags: number | null,
  loose: number | null,
  pieces: number | null,
  perBag: number | null,
): number {
  if (mode === "bags") return perBag ? (bags ?? 0) * perBag + (loose ?? 0) : 0;
  return pieces ?? 0;
}
