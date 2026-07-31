import { db } from './client.js';
import { SCHEMA_SQL } from './schema.js';

export function migrate(): void {
  db.exec(SCHEMA_SQL);
  ensureColumn('inventory_transactions', 'actor', 'TEXT');
  ensureColumn('payroll_runs', 'staff_name', 'TEXT');
  // Backfill existing payroll rows created before staff_name existed.
  db.exec(`UPDATE payroll_runs SET staff_name = (SELECT name FROM employees WHERE employees.id = payroll_runs.staff_id) WHERE staff_name IS NULL`);
}

/** CREATE TABLE IF NOT EXISTS above only shapes a fresh database — existing
 *  installs need columns added explicitly when the schema grows a field. */
function ensureColumn(table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
