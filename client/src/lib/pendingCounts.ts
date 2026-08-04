import { useEffect, useState } from 'react';
import { api } from './apiClient';

export type PendingCounts = Record<string, number>;

const POLL_MS = 60_000;
const REFRESH_EVENT = 'elim:pending-counts-refresh';

/** Call after any approve/reject/inspect/verify action so the sidebar badge
 *  (and any tab badge reading the same counts) drops immediately instead of
 *  waiting for the next poll or focus event. */
export function refreshPendingCounts(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/** Backs the sidebar's action-required badges (see Sidebar.tsx) — refetched
 *  on an interval, on window focus, and whenever refreshPendingCounts() is
 *  called after a treat-action completes, since none of these have a push
 *  channel to know when another session (or this one) changes something. */
export function usePendingCounts(): PendingCounts {
  const [counts, setCounts] = useState<PendingCounts>({});

  useEffect(() => {
    let alive = true;
    const fetchCounts = () => {
      api<PendingCounts>('/pending-counts').then(res => { if (alive) setCounts(res); });
    };
    fetchCounts();
    const interval = setInterval(fetchCounts, POLL_MS);
    window.addEventListener('focus', fetchCounts);
    window.addEventListener(REFRESH_EVENT, fetchCounts);
    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener('focus', fetchCounts);
      window.removeEventListener(REFRESH_EVENT, fetchCounts);
    };
  }, []);

  return counts;
}
