// The name a sale line shows everywhere it is listed (user, 2026-11-09): a
// dispenser sold with its jug for good (jar_mode 'permanent') is "Jug + Water"
// at N4,200, beside Dispenser Water (N1,200) and Empty Jug (N3,000). The
// database names its lines the same way (_sale_line_name, 20261109120000).
export const JUG_PLUS_WATER = "Jug + Water";

export function saleLineName(name: string | null | undefined, jarMode?: string | null): string {
  return jarMode === "permanent" ? JUG_PLUS_WATER : (name ?? "—");
}
