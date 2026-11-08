// The name a sale line shows everywhere it is listed (user, 2026-11-08): a
// dispenser sold with its jug for good (jar_mode 'permanent') is
// "Jug + Dispenser Water ...", never just the water. sale_invoice_lines()
// names its lines the same way in the database
// (supabase/migrations/20261108100000_jug_dispenser_name_gifts_rep_edit.sql).
export const JUG_PLUS_PREFIX = "Jug + ";

export function saleLineName(name: string | null | undefined, jarMode?: string | null): string {
  const n = name ?? "—";
  if (jarMode !== "permanent") return n;
  return n.startsWith(JUG_PLUS_PREFIX) ? n : `${JUG_PLUS_PREFIX}${n}`;
}
