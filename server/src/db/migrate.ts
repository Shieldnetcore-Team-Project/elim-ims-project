import { db } from './client.js';
import { SCHEMA_SQL, SCHEMA_UPGRADES_SQL, FOREIGN_KEYS_SQL, REFERENCE_DATA_SQL } from './schema.js';

/** Applies the full Postgres schema. Every statement is idempotent
 *  (CREATE TABLE/INDEX IF NOT EXISTS, a duplicate_object-tolerant DO block per
 *  foreign key, ON CONFLICT DO NOTHING for reference rows), so re-running this
 *  on an already-migrated database is safe — there's no SQLite-style guarded
 *  table-rebuild machinery to maintain here, since Postgres can ALTER TABLE
 *  ADD COLUMN/CONSTRAINT natively and this schema already reflects the final
 *  shape of every table. */
export async function migrate(): Promise<void> {
  await db.exec(SCHEMA_SQL);
  await db.exec(SCHEMA_UPGRADES_SQL);
  await db.exec(FOREIGN_KEYS_SQL);
  await db.exec(REFERENCE_DATA_SQL);
}
