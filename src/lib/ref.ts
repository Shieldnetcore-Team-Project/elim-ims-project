// Transaction IDs. Every record's uuid doubles as its traceable ID; the UI
// shows the first 8 characters ("#A1B2C3D4"), which is plenty to tell records
// apart. Copying one and pasting it into any search box — a page's, the top
// bar's, or Audit Logs — finds that record, or its trail once it's deleted.

const HEX_RE = /^[0-9a-f]+$/;

/** Short, display/copy form of a record id: "#A1B2C3D4". */
export function shortRef(id: string | null | undefined): string {
  if (!id) return "";
  return `#${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/**
 * The hex an ID search term stands for, or null when the term isn't an ID:
 * "#a1b2c3d4", "A1B2C3D4" or a full uuid (dashes optional). At least 6
 * characters, so ordinary short words never match an id by accident.
 */
export function refHex(term: string): string | null {
  const t = term.trim().toLowerCase().replace(/^#/, "").replace(/-/g, "");
  if (t.length < 6 || t.length > 32 || !HEX_RE.test(t)) return null;
  return t;
}

/** True when `id` is the record that ID search `hex` (from refHex) points at. */
export function idMatches(id: string | null | undefined, hex: string): boolean {
  return !!id && id.replace(/-/g, "").toLowerCase().startsWith(hex);
}

/**
 * Inclusive uuid bounds covering every id that starts with `hex`, for
 * server-side lookups (`.gte("id", lo).lte("id", hi)`) — uuid columns can't
 * be pattern-matched through PostgREST.
 */
export function uuidRange(hex: string): [string, string] {
  const fmt = (h: string) =>
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return [fmt(hex.padEnd(32, "0")), fmt(hex.padEnd(32, "f"))];
}

/** Whether `query` is an ID search (single term that looks like an ID). */
export function isRefQuery(query: string): boolean {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  return parts.length === 1 && refHex(parts[0]) !== null;
}

/**
 * The uuid text prefix (with dashes) for `hex`, for LIKE matches on text
 * columns that store a uuid — e.g. audit_logs.entity_id.
 */
export function uuidPrefix(hex: string): string {
  const cuts = [8, 12, 16, 20];
  let out = "";
  for (let i = 0; i < hex.length; i++) {
    if (cuts.includes(i)) out += "-";
    out += hex[i];
  }
  return out;
}
