import { db } from './client.js';
import { SCHEMA_SQL } from './schema.js';

export function migrate(): void {
  db.exec(SCHEMA_SQL);
}
