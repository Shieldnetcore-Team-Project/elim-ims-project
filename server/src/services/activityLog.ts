import { db } from '../db/client.js';

export interface ActivityEntry {
  id: number;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string | null;
  at: string;
}

/** Every mutating service call ends with one of these — this table is the audit trail.
 *  Prepared lazily inside the call (not at module load) so this doesn't run before
 *  migrate() has created the table. */
export function record(actor: string, action: string, targetType: string, targetId: string, summary: string): void {
  db.prepare(`INSERT INTO activity_log (actor, action, target_type, target_id, summary) VALUES (?, ?, ?, ?, ?)`)
    .run(actor, action, targetType, targetId, summary);
}

export function list(limit = 200): ActivityEntry[] {
  return db.prepare(`SELECT * FROM activity_log ORDER BY id DESC LIMIT ?`).all(limit) as unknown as ActivityEntry[];
}
