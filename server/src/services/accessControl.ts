import { db } from '../db/client.js';
import * as activityLog from './activityLog.js';

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === 'System admin';
}

/** The one place a server route can look up who a caller actually is —
 *  everywhere else in this app trusts a free-text `actor` string, but a
 *  block that names a specific role ("Warehouse Manager only") needs a real
 *  lookup against the users table, not a self-reported name. */
export function getUser(userId: string): { id: string; name: string; role: string } | undefined {
  return db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId) as { id: string; name: string; role: string } | undefined;
}

/** Module 17 reversal gates and every other exact-role-match check in this app
 *  (Module 5's Warehouse Manager override, Module 13's Sales manager reprint
 *  approval) share this shape — real server-side role lookup, System admin always
 *  passes, no other bypass. Centralised here so the 6 new reverse endpoints don't
 *  each reimplement the same check. */
export function requireRole(userId: string | undefined, allowedRoles: string[]): { id: string; name: string; role: string } {
  if (!userId) throw new Error(`Only ${allowedRoles.join(' or ')} (or System admin) can perform this action`);
  const user = getUser(userId);
  if (!user || (!allowedRoles.includes(user.role) && !isSuperAdminRole(user.role))) {
    throw new Error(`Only ${allowedRoles.join(' or ')} (or System admin) can perform this action`);
  }
  return user;
}

export function getAccess(userId: string): string[] {
  return (db.prepare('SELECT page_key FROM user_page_access WHERE user_id = ?').all(userId) as { page_key: string }[])
    .map(r => r.page_key);
}

/** Dual-control gate: a capability key (e.g. 'procurement-approve') granted
 *  the same way as ordinary page access, but never rendered as a sidebar nav
 *  item — it only unlocks an approve/reject action within a page the
 *  requester and the approver can both otherwise see. System admin always
 *  passes, same as every other access check in this app. */
export function hasPageAccess(userId: string | undefined, pageKey: string): boolean {
  if (!userId) return false;
  const user = getUser(userId);
  if (!user) return false;
  if (isSuperAdminRole(user.role)) return true;
  return getAccess(userId).includes(pageKey);
}

export function requirePageAccess(userId: string | undefined, pageKey: string, actionLabel: string): void {
  if (!hasPageAccess(userId, pageKey)) {
    throw new Error(`Only a System admin or someone granted "${actionLabel}" access can do this`);
  }
}

export function setAccess(userId: string, pageKeys: string[], actor: string): string[] {
  db.prepare('DELETE FROM user_page_access WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_page_access (user_id, page_key) VALUES (?,?)');
  for (const key of pageKeys) insert.run(userId, key);
  activityLog.record(actor, 'updated page access for', 'user', userId, `Granted: ${pageKeys.join(', ') || '(none)'}`);
  return getAccess(userId);
}
