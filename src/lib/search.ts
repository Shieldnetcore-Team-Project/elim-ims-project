import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { format } from "date-fns";
import { refHex } from "@/lib/ref";

// Free-text search shared by every search box. A record matches when every
// word typed appears somewhere in it — any field, including nested relations
// (customer, product, category names…), case-insensitive, as the user types.
//   - Amounts match with or without separators/currency: "5000", "5,000", "₦5,000".
//   - Statuses/enums match with spaces: "pending approval" finds pending_approval.
//   - Dates match as stored (2026-09-23) or as shown (23 Sep 2026, 23/09/2026, Sep 2026).
//   - Transaction IDs: "#A1B2C3D4" (as shown/copied), the bare hex or a full
//     uuid matches the record whose id — or any linked id (customer_id,
//     sale_id…) — starts with it. Otherwise ids, uuids and links are skipped
//     so a single character doesn't match every row through a hidden id.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const SKIP_KEY_RE = /(^id$|_id$|_url$)/;

function collect(value: unknown, out: string[], ids: string[], depth: number) {
  if (value == null || depth > 5) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return;
    out.push(String(value), value.toFixed(2));
    return;
  }
  if (typeof value === "string") {
    const v = value.trim();
    if (!v || /^https?:\/\//i.test(v)) return;
    if (UUID_RE.test(v)) {
      ids.push(v.replace(/-/g, "").toLowerCase());
      return;
    }
    out.push(v);
    if (v.includes("_")) out.push(v.replace(/_/g, " "));
    if (ISO_DATE_RE.test(v)) {
      const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
      if (!Number.isNaN(d.getTime())) {
        out.push(format(d, "d MMM yyyy"), format(d, "dd/MM/yyyy"), format(d, "MMMM yyyy"));
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, ids, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!SKIP_KEY_RE.test(k)) collect(v, out, ids, depth + 1);
      else if (typeof v === "string" && UUID_RE.test(v)) {
        ids.push(v.replace(/-/g, "").toLowerCase());
      }
    }
  }
}

type Haystack = { text: string; plain: string; ids: string[] };
const cache = new WeakMap<object, Haystack>();

function haystackOf(value: unknown): Haystack {
  if (value && typeof value === "object") {
    const hit = cache.get(value);
    if (hit) return hit;
  }
  const parts: string[] = [];
  const ids: string[] = [];
  collect(value, parts, ids, 0);
  const text = parts.join(" \u0001 ").toLowerCase();
  const hay = { text, plain: text.replace(/,/g, ""), ids };
  if (value && typeof value === "object") cache.set(value, hay);
  return hay;
}

type Term = { raw: string; plain: string; hex: string | null };

function terms(query: string): Term[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ raw: t, plain: t.replace(/[₦$£€,]/g, ""), hex: refHex(t) }))
    .filter((t) => t.plain.length > 0);
}

function hit(h: Haystack, t: Term) {
  return (
    h.text.includes(t.raw) ||
    h.plain.includes(t.plain) ||
    (!!t.hex && h.ids.some((id) => id.startsWith(t.hex!)))
  );
}

/**
 * True when `query` is empty, or every word in it is found in `record` or in
 * any of `extra` (display-only values the record doesn't carry, e.g. a user's
 * name looked up from an id, or a formatted label).
 */
export function matchesSearch(query: string, record: unknown, ...extra: unknown[]): boolean {
  const ts = terms(query);
  if (ts.length === 0) return true;
  const main = haystackOf(record);
  const more = extra.length ? haystackOf(extra) : null;
  return ts.every((t) => hit(main, t) || (!!more && hit(more, t)));
}

/**
 * A page search box's state, seeded from `?q=` in the URL and updated when
 * it changes — so the top-bar search can open (or re-filter) a page.
 */
export function useSearchQuery(): [string, (v: string) => void] {
  const urlQ = useRouterState({
    select: (st) => {
      const v = (st.location.search as Record<string, unknown> | undefined)?.q;
      return v == null ? "" : String(v);
    },
  });
  const [q, setQ] = useState(urlQ);
  useEffect(() => {
    if (urlQ) setQ(urlQ);
  }, [urlQ]);
  return [q, setQ];
}
