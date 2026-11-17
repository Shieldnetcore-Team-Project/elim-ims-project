import { addDays, endOfMonth, format, parseISO, startOfWeek } from "date-fns";

// "OPERATIONS: WEEKLY SALES REPORT FROM .. TO .." — the factory's own sheet
// (user, 2026-11-17): S/N, Marketer/Distributor down the side, every product
// across the top, the quantity each party took in the period. Figures come
// from sales_report_by_party() (20261117100000): posted out less returned.

export type PartyType = "marketer" | "distributor" | "retail" | "direct";
export type PartyGroup = "all" | "marketer" | "distributor" | "retail";
export type PeriodKind = "weekly" | "monthly" | "yearly" | "custom";

export const PARTY_GROUPS: { key: PartyGroup; label: string; heading: string }[] = [
  { key: "all", label: "General (everyone)", heading: "" },
  { key: "marketer", label: "Marketers", heading: "Marketers" },
  {
    key: "distributor",
    label: "Distributor/Office Delivery",
    heading: "Distributor/Office Delivery",
  },
  { key: "retail", label: "Retail Shop", heading: "Retail Shop" },
];

export type PartySalesRow = {
  row_kind: "product" | "party" | "line";
  party_type: PartyType | null;
  party_id: string | null;
  party_name: string | null;
  party_code: string | null;
  product_name: string | null;
  quantity: number | string;
};

export type PartySalesParty = {
  key: string;
  type: PartyType;
  name: string;
  code: string | null;
  qty: Record<string, number>;
  total: number;
};

export type PartySalesReport = {
  products: string[];
  parties: PartySalesParty[];
  totals: Record<string, number>;
};

// The sheet's own headings for the products it had; anything else keeps its name.
export function productLabel(name: string): string {
  const n = name.trim();
  if (/^dispenser water$/i.test(n)) return "Jug (H2O only)";
  if (/^empty jug$/i.test(n)) return "Jugs Only";
  if (/sachet/i.test(n)) return "Sachet";
  if (/^cup\b|\bcup water\b/i.test(n)) return "Cup";
  const cl = n.match(/(\d+(?:\.\d+)?)\s*cl\b/i);
  if (cl) return `${cl[1]}CL`;
  // "1.5Ltr Bottle Water" prints as just "1.5Ltr" (user, 2026-11-17).
  const ltr = n.match(/(\d+(?:\.\d+)?)\s*(?:ltr|litres?|liters?|l)\b/i);
  if (ltr) return `${ltr[1]}Ltr`;
  return n;
}

// Jug columns first, then bottles largest first, then cup, then sachet (as the sheet).
function productRank(name: string): [number, number, string] {
  const n = name.toLowerCase();
  if (/^dispenser water$/.test(n)) return [0, 0, n];
  if (/^empty jug$/.test(n)) return [1, 0, n];
  if (/jug|dispenser/.test(n)) return [2, 0, n];
  const cl = n.match(/(\d+(?:\.\d+)?)\s*cl\b/);
  if (cl) return [3, -Number(cl[1]), n];
  // Litre bottles sit with the cl ones by size (1.5Ltr = 150cl).
  const ltr = n.match(/(\d+(?:\.\d+)?)\s*(?:ltr|litres?|liters?|l)\b/);
  if (ltr) return [3, -Number(ltr[1]) * 100, n];
  if (/\bcup\b/.test(n)) return [5, 0, n];
  if (/sachet/.test(n)) return [6, 0, n];
  return [4, 0, n];
}

const cmpProduct = (a: string, b: string) => {
  const [ra, sa, na] = productRank(a);
  const [rb, sb, nb] = productRank(b);
  return ra - rb || sa - sb || na.localeCompare(nb);
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function buildPartySales(
  rows: PartySalesRow[],
  group: PartyGroup = "all",
  hideEmpty = false,
): PartySalesReport {
  const products = new Set<string>();
  const parties = new Map<string, PartySalesParty>();
  const partyOf = (r: PartySalesRow) => {
    const type = r.party_type as PartyType;
    const key = `${type}:${r.party_id ?? r.party_name ?? ""}`;
    let p = parties.get(key);
    if (!p) {
      p = { key, type, name: r.party_name ?? "—", code: r.party_code, qty: {}, total: 0 };
      parties.set(key, p);
    }
    return p;
  };
  for (const r of rows) {
    if (r.row_kind === "product" && r.product_name) products.add(r.product_name);
    else if (r.row_kind === "party" && r.party_type) partyOf(r);
    else if (r.row_kind === "line" && r.party_type && r.product_name) {
      products.add(r.product_name);
      const p = partyOf(r);
      p.qty[r.product_name] = round3((p.qty[r.product_name] ?? 0) + Number(r.quantity || 0));
    }
  }
  const productList = [...products].sort(cmpProduct);
  const list = [...parties.values()]
    .filter((p) => group === "all" || p.type === group)
    .map((p) => ({
      ...p,
      total: round3(productList.reduce((s, name) => s + (p.qty[name] ?? 0), 0)),
    }))
    .filter((p) => !hideEmpty || productList.some((name) => (p.qty[name] ?? 0) !== 0))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const totals = Object.fromEntries(
    productList.map((name) => [name, round3(list.reduce((s, p) => s + (p.qty[name] ?? 0), 0))]),
  );
  return { products: productList, parties: list, totals };
}

// Keyed columns/rows for the screen, Excel and the letterhead print. The last
// row is the "Total" line.
export function partySalesTable(report: PartySalesReport) {
  const columns = [
    { key: "sn", label: "S/N" },
    { key: "party", label: "Marketer/Distributor" },
    ...report.products.map((name, i) => ({ key: `p${i}`, label: productLabel(name) })),
  ];
  const rows: Record<string, unknown>[] = report.parties.map((p, idx) => ({
    sn: idx + 1,
    party: p.name,
    ...Object.fromEntries(report.products.map((name, i) => [`p${i}`, p.qty[name] ?? 0])),
  }));
  if (rows.length > 0)
    rows.push({
      sn: "",
      party: "Total",
      ...Object.fromEntries(report.products.map((name, i) => [`p${i}`, report.totals[name] ?? 0])),
    });
  return { columns, rows };
}

// The period picked → from/to days (yyyy-MM-dd). A week runs Monday to Sunday.
export function periodDays(
  kind: PeriodKind,
  pick: { day: string; year: number; month: number; from: string; to: string },
): { from: string; to: string } {
  if (kind === "weekly") {
    const mon = startOfWeek(parseISO(pick.day), { weekStartsOn: 1 });
    return { from: format(mon, "yyyy-MM-dd"), to: format(addDays(mon, 6), "yyyy-MM-dd") };
  }
  if (kind === "monthly") {
    const first = new Date(pick.year, pick.month, 1);
    return { from: format(first, "yyyy-MM-dd"), to: format(endOfMonth(first), "yyyy-MM-dd") };
  }
  if (kind === "yearly") return { from: `${pick.year}-01-01`, to: `${pick.year}-12-31` };
  return pick.from <= pick.to ? { from: pick.from, to: pick.to } : { from: pick.to, to: pick.from };
}

// "OPERATIONS: WEEKLY SALES REPORT FROM 2022-11-14 TO 2022-11-19" (the print
// puts it in capitals); a group adds its name.
export function partySalesTitle(kind: PeriodKind, group: PartyGroup, from: string, to: string) {
  const word = kind === "custom" ? "" : `${kind[0].toUpperCase()}${kind.slice(1)} `;
  const heading = PARTY_GROUPS.find((g) => g.key === group)?.heading;
  return `Operations: ${word}Sales Report${heading ? ` (${heading})` : ""} from ${from} to ${to}`;
}
