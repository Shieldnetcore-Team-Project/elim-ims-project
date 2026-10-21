// Preform quantities are stored in pieces. Bags are for entry and display:
// pieces = bags x pieces per bag + loose pieces. A balance that is not a
// whole number of bags shows the whole bags plus the remaining pieces --
// a remainder is never rounded away.

export type BagSplit = { bags: number; pieces: number };

export function splitBags(pieces: number, perBag: number | null | undefined): BagSplit | null {
  if (!perBag || perBag <= 0 || !Number.isFinite(pieces)) return null;
  const sign = pieces < 0 ? -1 : 1;
  const abs = Math.abs(pieces);
  const bags = Math.floor(abs / perBag);
  return { bags: sign * bags, pieces: sign * (abs - bags * perBag) };
}

export function toPieces(bags: number, loose: number, perBag: number): number {
  return bags * perBag + loose;
}

const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

// "46,080 pcs (40 bags)", "46,081 pcs (40 bags + 1 pc)", "500 pcs (0 bags + 500 pcs)"
export function formatPieces(pieces: number, perBag: number | null | undefined): string {
  const base = `${fmt(pieces)} pcs`;
  const s = splitBags(pieces, perBag);
  if (!s) return base;
  return `${base} (${formatBags(s)})`;
}

// "40 bags", "40 bags + 1 pc", "1 bag + 576 pcs"
export function formatBags(s: BagSplit): string {
  const bags = `${fmt(s.bags)} ${Math.abs(s.bags) === 1 ? "bag" : "bags"}`;
  if (s.pieces === 0) return bags;
  return `${bags} + ${fmt(Math.abs(s.pieces))} ${Math.abs(s.pieces) === 1 ? "pc" : "pcs"}`;
}

// Preform weight: grams per piece is set once per preform and only describes
// the piece -- stock stays in pieces. "18 g", "18.5 g"
export function formatGrams(grams: number | null | undefined): string | null {
  if (!grams || grams <= 0) return null;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(grams)} g`;
}

// Total weight of a number of pieces: "1,152 g", "20.74 kg"
export function formatWeight(pieces: number, grams: number | null | undefined): string | null {
  if (!grams || grams <= 0 || !Number.isFinite(pieces)) return null;
  const g = pieces * grams;
  return Math.abs(g) >= 1000
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(g / 1000)} kg`
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(g)} g`;
}

// Pieces in a delivery entered by total weight: weight ÷ grams per piece,
// to the nearest whole piece. 0 when either is missing.
export function piecesFromWeight(
  totalGrams: number | null | undefined,
  grams: number | null | undefined,
): number {
  if (!totalGrams || totalGrams <= 0 || !grams || grams <= 0) return 0;
  return Math.round(totalGrams / grams);
}
