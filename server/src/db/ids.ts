import { db } from './client.js';

const SAFE_TABLE = /^[a-z_]+$/;

/** Business-facing IDs like "PO-2026-00042": look at the highest existing
 *  suffix for this prefix and add one. `table` is only ever a hardcoded
 *  literal from our own code, never user input. */
export async function nextBusinessId(table: string, prefix: string, digits = 4): Promise<string> {
  if (!SAFE_TABLE.test(table)) throw new Error(`Unsafe table name: ${table}`);
  const row = await db.prepare(`SELECT id FROM ${table} WHERE id LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '%') as
    | { id: string }
    | undefined;
  let next = 1;
  if (row) {
    const n = parseInt(row.id.slice(prefix.length), 10);
    if (!Number.isNaN(n)) next = n + 1;
  }
  return prefix + String(next).padStart(digits, '0');
}
