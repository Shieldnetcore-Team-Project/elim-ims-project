import { useEffect, useState } from 'react';
import { api } from './apiClient';

export interface ReversalRow {
  id: string; entity_type: string; entity_id: string; reversed_by: string; reason: string;
  old_value: string | null; new_value: string | null; reversed_at: string;
}

/** Ids within `entityType` that have already been reversed (Module 17) — used to
 *  disable/badge a row's Reverse button, mirroring usePendingDeletions(). */
export function useReversedEntities(entityType: string, reloadKey?: unknown): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    api<ReversalRow[]>('/reversals', { entityType }).then(rows => {
      if (alive) setIds(new Set(rows.map(r => r.entity_id)));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, reloadKey]);

  return ids;
}
