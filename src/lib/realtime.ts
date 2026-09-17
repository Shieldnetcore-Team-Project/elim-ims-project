import { useEffect, useId, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
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
 */
export function useRealtimeInvalidate(tables: string[], queryKeys: QueryKey[]) {
  const qc = useQueryClient();
  const id = useId();
  const queryKeysRef = useRef(queryKeys);
  queryKeysRef.current = queryKeys;
  const tableKey = tables.join(",");

  useEffect(() => {
    if (!tableKey) return;
    const channel = supabase.channel(`live:${tableKey}:${id}`);
    for (const table of tables) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
        for (const queryKey of queryKeysRef.current) qc.invalidateQueries({ queryKey });
      });
    }
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, id, qc]);
}
