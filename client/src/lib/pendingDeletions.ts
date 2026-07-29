import { useEffect, useState } from 'react';
import { api } from './apiClient';

export interface DeletionRequestRow {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  requested_by: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

/** Ids within `entityType` that already have a deletion request in flight — used to
 *  disable/badge a row's delete button instead of letting duplicate requests pile up. */
export function usePendingDeletions(entityType: string, reloadKey?: unknown): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    api<DeletionRequestRow[]>('/deletion-requests', { status: 'PENDING' }).then(rows => {
      if (alive) setIds(new Set(rows.filter(r => r.entity_type === entityType).map(r => r.entity_id)));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, reloadKey]);

  return ids;
}
