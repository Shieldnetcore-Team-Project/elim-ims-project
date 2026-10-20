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
