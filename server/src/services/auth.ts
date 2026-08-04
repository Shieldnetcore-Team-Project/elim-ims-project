import bcrypt from 'bcryptjs';
import { db } from '../db/client.js';
import * as peripheral from './peripheral.js';

const SALT_ROUNDS = 10;

// Role granted to self-registered accounts. Doesn't match any exact-role-match
// gate (System admin / Warehouse Manager / Sales manager / Finance manager)
// and getAccess() returns no pages for a brand new user id, so a fresh
// sign-up sees only the Dashboard until a System admin grants specific pages
// via Admin Panel > Access Control.
const SELF_SIGNUP_ROLE = 'Viewer';

// Applied once to any user row that predates password auth (every account
// seeded before this module existed) so the app stays usable without every
// account being reset by hand. Disclosed to whoever runs the migration.
export const DEFAULT_PASSWORD = 'password123';

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

export function setPassword(userId: string, plain: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(plain), userId);
}

export function verifyPassword(userId: string, plain: string): boolean {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null } | undefined;
  if (!row?.password_hash) return false;
  return bcrypt.compareSync(plain, row.password_hash);
}

export function isSuspended(userId: string): boolean {
  const row = db.prepare('SELECT status FROM users WHERE id = ?').get(userId) as { status: string } | undefined;
  return row?.status === 'SUSPENDED';
}

export interface PublicUser { id: string; name: string; email: string; role: string; status: string }

export function emailExists(email: string): boolean {
  return !!db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
}

/** Self-service account creation from the sign-up form — reuses peripheral.create
 *  (same ID generation + activity log as an admin creating a user from the Users
 *  module) rather than a bespoke insert, so a self-registered account is exactly
 *  as auditable as an admin-created one. */
export function createAccount(name: string, email: string, password: string): PublicUser {
  if (emailExists(email)) throw new Error('An account with that email already exists');
  const row = peripheral.create('users', `${name} (self sign-up)`, undefined, 'ACTIVE', {
    name, email, role: SELF_SIGNUP_ROLE, last_active: new Date().toISOString(),
  });
  if (!row) throw new Error('Could not create account');
  setPassword(row.id, password);
  return { id: row.id, name, email, role: SELF_SIGNUP_ROLE, status: 'ACTIVE' };
}

/** Fresh SQLite installs have historically shipped ~16 pre-seeded accounts with
 *  no password at all. Runs on every boot so any such account gets a known
 *  default the moment this column exists, instead of being locked out forever. */
export function ensureDefaultPasswords(): void {
  const rows = db.prepare('SELECT id FROM users WHERE password_hash IS NULL').all() as { id: string }[];
  if (rows.length === 0) return;
  const hash = hashPassword(DEFAULT_PASSWORD);
  const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  for (const row of rows) stmt.run(hash, row.id);
}
