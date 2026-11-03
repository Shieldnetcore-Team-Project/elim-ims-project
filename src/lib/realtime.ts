import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/**
 * Subscribes to Postgres changes on `tables` and invalidates `queryKeys`
 * whenever any row in them is inserted/updated/deleted, so every open
 * browser tab picks up other users' stock adjustments, receipts, edits, etc.
 * without a manual refresh. Each entry in `queryKeys` is treated as a prefix
 * (TanStack Query's default partial match), so e.g. ["raw-materials-list"]
 * also invalidates ["raw-materials-list", factoryId].
 *
 * `tables` must already be added to the `supabase_realtime` publication
 * (see supabase/migrations) or no events will ever arrive.
 *
 * Disk IO (2026-11-03): one posting writes several rows (the sale, its
 * payments, stock and jug moves...), and every hook used to open its own
 * channel and refetch on each row. Now
 *   - a browser tab holds ONE channel per table, shared by every hook that
 *     watches it (the sidebar and top bar both watch the approval tables);
 *   - events are gathered for FLUSH_MS and each query key is invalidated
 *     once for the batch.
 */
const FLUSH_MS = 1000;

export type Listener = { qc: QueryClient; keys: () => QueryKey[] };
type TableSub = { channel: RealtimeChannel; listeners: Set<Listener> };

const subs = new Map<string, TableSub>();
const pending = new Map<QueryClient, Map<string, QueryKey>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function flush() {
  timer = null;
  const batch = [...pending];
  pending.clear();
  for (const [qc, keys] of batch)
    for (const queryKey of keys.values()) void qc.invalidateQueries({ queryKey });
}

function schedule(listener: Listener) {
  let keys = pending.get(listener.qc);
  if (!keys) pending.set(listener.qc, (keys = new Map()));
  for (const k of listener.keys()) keys.set(JSON.stringify(k), k);
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

// Exported for src/lib/realtime.test.ts; pages use useRealtimeInvalidate.
export function watch(table: string, listener: Listener): () => void {
  let sub = subs.get(table);
  if (!sub) {
    const listeners = new Set<Listener>();
    // A fresh topic each time: a channel being removed may still be closing.
    const channel = supabase
      .channel(`live:${table}:${++seq}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        for (const l of listeners) schedule(l);
      })
      .subscribe();
    sub = { channel, listeners };
    subs.set(table, sub);
  }
  const mine = sub;
  mine.listeners.add(listener);
  return () => {
    mine.listeners.delete(listener);
    if (mine.listeners.size === 0 && subs.get(table) === mine) {
      subs.delete(table);
      void supabase.removeChannel(mine.channel);
    }
  };
}

export function useRealtimeInvalidate(tables: string[], queryKeys: QueryKey[]) {
  const qc = useQueryClient();
  const queryKeysRef = useRef(queryKeys);
  queryKeysRef.current = queryKeys;
  const tableKey = tables.join(",");

  useEffect(() => {
    if (!tableKey) return;
    const listener: Listener = { qc, keys: () => queryKeysRef.current };
    const stops = tableKey.split(",").map((t) => watch(t, listener));
    return () => stops.forEach((stop) => stop());
  }, [tableKey, qc]);
}
