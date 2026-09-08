import { db } from '../db/client.js';
import { migrate } from '../db/migrate.js';

let migrated = false;
/** globalSetup lays the schema down once per run; this is a per-process safety
 *  net (and covers running a single file with `vitest run path`). migrate() is
 *  idempotent, and with isolate:false the guard makes it a no-op after the first
 *  call anyway. */
export async function ensureMigrated(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
}

let seq = 0;
export function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now()}-${seq}`;
}

export async function makeItem(
  overrides: Partial<{ name: string; type: string; unitCost: number }> = {},
): Promise<string> {
  const id = uniqueId('TST-ITEM-');
  await db
    .prepare(`INSERT INTO items (id, name, category, type, uom, reorder_point, unit_cost) VALUES (?,?,?,?,?,?,?)`)
    .run(id, overrides.name ?? 'Test item', 'Test', overrides.type ?? 'FINISHED_GOOD', 'unit', 0, overrides.unitCost ?? 100);
  return id;
}

export async function makeSupplier(name = 'Test Supplier'): Promise<string> {
  const id = uniqueId('TST-SUP-');
  await db.prepare(`INSERT INTO suppliers (id, name) VALUES (?,?)`).run(id, name);
  return id;
}
