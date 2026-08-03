import { db } from '../db/client.js';
import { migrate } from '../db/migrate.js';

let migrated = false;
/** migrate() is idempotent (CREATE TABLE IF NOT EXISTS / guarded ensureColumn calls),
 *  so every test file can call this in its own beforeAll without worrying about
 *  running it more than once against the shared temp db (see vitest.config.ts). */
export function ensureMigrated(): void {
  if (!migrated) { migrate(); migrated = true; }
}

let seq = 0;
export function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now()}-${seq}`;
}

export function makeItem(overrides: Partial<{ name: string; type: string; unitCost: number }> = {}): string {
  const id = uniqueId('TST-ITEM-');
  db.prepare(`INSERT INTO items (id, name, category, type, uom, reorder_point, unit_cost) VALUES (?,?,?,?,?,?,?)`)
    .run(id, overrides.name ?? 'Test item', 'Test', overrides.type ?? 'FINISHED_GOOD', 'unit', 0, overrides.unitCost ?? 100);
  return id;
}

export function makeSupplier(name = 'Test Supplier'): string {
  const id = uniqueId('TST-SUP-');
  db.prepare(`INSERT INTO suppliers (id, name) VALUES (?,?)`).run(id, name);
  return id;
}
