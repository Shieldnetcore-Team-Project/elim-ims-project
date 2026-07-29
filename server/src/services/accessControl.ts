import { db } from '../db/client.js';
import * as activityLog from './activityLog.js';

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === 'System admin';
}

export function getAccess(userId: string): string[] {
  return (db.prepare('SELECT page_key FROM user_page_access WHERE user_id = ?').all(userId) as { page_key: string }[])
    .map(r => r.page_key);
}

export function setAccess(userId: string, pageKeys: string[], actor: string): string[] {
  db.prepare('DELETE FROM user_page_access WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_page_access (user_id, page_key) VALUES (?,?)');
  for (const key of pageKeys) insert.run(userId, key);
  activityLog.record(actor, 'updated page access for', 'user', userId, `Granted: ${pageKeys.join(', ') || '(none)'}`);
  return getAccess(userId);
}
