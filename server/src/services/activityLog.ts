import { db } from '../db/client.js';
import { currentRequestContext } from '../lib/requestContext.js';

export interface ActivityEntry {
  id: number;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string | null;
  department: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  ip_address: string | null;
  device: string | null;
  at: string;
}

/** Best-effort "Department" (Module 17) — this app has no users.department column,
 *  and actor is mostly a free-text display name, not a user id. Roles already read as
 *  department names here ('Water treatment', 'Finance & people', ...), so a role
 *  lookup by name is a reasonable proxy. Returns null for actors that aren't a real
 *  user's name (e.g. the literal 'System Administrator'/'Finance' defaults used as
 *  actor in several existing calls) — a real but acceptable gap, not a bug. */
function resolveDepartment(actor: string): string | null {
  const row = db.prepare('SELECT role FROM users WHERE name = ?').get(actor) as { role: string | null } | undefined;
  return row?.role ?? null;
}

/** Every mutating service call ends with one of these — this table is the audit trail.
 *  Prepared lazily inside the call (not at module load) so this doesn't run before
 *  migrate() has created the table. `extra` (Module 17) is additive-only: every
 *  existing 5-arg call site keeps compiling unchanged and now gets ip/device/department
 *  captured for free; old_value/new_value/reason stay null unless a caller (a reversal,
 *  or a master-data edit) actually has something to report. */
export function record(
  actor: string, action: string, targetType: string, targetId: string, summary: string,
  extra?: { department?: string | null; oldValue?: string | null; newValue?: string | null; reason?: string | null },
): void {
  const { ipAddress, device } = currentRequestContext();
  const department = extra?.department !== undefined ? extra.department : resolveDepartment(actor);
  db.prepare(
    `INSERT INTO activity_log (actor, action, target_type, target_id, summary, department, old_value, new_value, reason, ip_address, device)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(actor, action, targetType, targetId, summary, department, extra?.oldValue ?? null, extra?.newValue ?? null, extra?.reason ?? null, ipAddress, device);
}

export function list(limit = 200): ActivityEntry[] {
  return db.prepare(`SELECT * FROM activity_log ORDER BY id DESC LIMIT ?`).all(limit) as unknown as ActivityEntry[];
}
