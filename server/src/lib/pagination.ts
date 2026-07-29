import type { Paginated } from '../../../shared/src/types.js';

export function paginate<T>(rows: T[], page: number, pageSize: number): Paginated<T> {
  const safePage = Math.max(1, page || 1);
  const safeSize = Math.max(1, Math.min(pageSize || 10, 100));
  const start = (safePage - 1) * safeSize;
  return { rows: rows.slice(start, start + safeSize), total: rows.length, page: safePage, pageSize: safeSize };
}
