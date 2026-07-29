import type { ModuleRow } from '../../../shared/src/types.js';

export function matchesQuery(haystack: (string | number | undefined)[], q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return haystack.some(v => v != null && String(v).toLowerCase().includes(needle));
}

export function filterModuleRows(rows: ModuleRow[], query: string, status: string): ModuleRow[] {
  return rows.filter(r =>
    (!status || r.status === status) &&
    matchesQuery([r.id, r.status, ...Object.values(r.fields)], query));
}
