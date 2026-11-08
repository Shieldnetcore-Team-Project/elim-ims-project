// What a jug type is called on screen (user, 2026-11-08): a returned empty is
// a "Dispenser Jug", never just "Old Jug" -- the stored types stay Old Jug /
// New Jug (20261023190000), only the label changes.
export function jugTypeLabel(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  const k = n.toLowerCase();
  if (k === "old jug") return "Dispenser Jug (Old)";
  if (k === "new jug") return "Dispenser Jug (New)";
  if (k === "jug") return "Dispenser Jug";
  return n || "—";
}
