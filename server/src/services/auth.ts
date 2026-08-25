import bcrypt from 'bcryptjs';
import { db } from '../db/client.js';
import * as peripheral from './peripheral.js';
import * as activityLog from './activityLog.js';

const SALT_ROUNDS = 10;

// Role granted to self-registered accounts. Doesn't match any exact-role-match
// gate (System admin / Warehouse Manager / Sales manager / Finance manager)
// and getAccess() returns no pages for a brand new user id, so a fresh
// sign-up sees only the Dashboard until a System admin grants specific pages
// via Admin Panel > Access Control.
const SELF_SIGNUP_ROLE = 'Viewer';

// Exact string checked everywhere else in this app (accessControl.isSuperAdminRole,
// client's currentUser.tsx SUPER_ADMIN_ROLE) to grant full, ungated access.
const SUPER_ADMIN_ROLE = 'System admin';

async function userCount(): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

// Applied once to any user row that predates password auth (every account
// seeded before this module existed) so the app stays usable without every
// account being reset by hand. Disclosed to whoever runs the migration.
export const DEFAULT_PASSWORD = 'password123';

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

export async function setPassword(userId: string, plain: string): Promise<void> {
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(plain), userId);
}

/** A System admin resetting someone else's password from Admin Panel > Users
 *  (distinct from authRouter's change-password, which is self-service and
 *  requires the current password) — logged since it's a security-relevant
 *  action, without ever writing the password itself into the audit trail. */
export async function adminSetPassword(userId: string, plain: string, actor: string): Promise<void> {
  await setPassword(userId, plain);
  await activityLog.record(actor, 'reset password for', 'users', userId, `Password reset for ${userId} by ${actor}`);
}

export async function verifyPassword(userId: string, plain: string): Promise<boolean> {
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null } | undefined;
  if (!row?.password_hash) return false;
  return bcrypt.compareSync(plain, row.password_hash);
}

/** Blocks sign-in for a self-registered account until a System admin flips its
 *  status to ACTIVE from Admin Panel > Users. Returns a user-facing message if
 *  login should be refused, or null if the account is clear to sign in. */
export async function loginBlockReason(userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT status FROM users WHERE id = ?').get(userId) as { status: string } | undefined;
  if (row?.status === 'SUSPENDED') return 'This account has been suspended';
  if (row?.status === 'PENDING_APPROVAL') return 'Your account is awaiting admin approval before you can sign in';
  return null;
}

export interface PublicUser { id: string; name: string; email: string; role: string; status: string }

export async function emailExists(email: string): Promise<boolean> {
  return !!(await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email));
}

/** Self-service account creation from the sign-up form — reuses peripheral.create
 *  (same ID generation + activity log as an admin creating a user from the Users
 *  module) rather than a bespoke insert, so a self-registered account is exactly
 *  as auditable as an admin-created one. Starts PENDING_APPROVAL rather than
 *  ACTIVE — a System admin must flip it to Active from Admin Panel > Users
 *  before the account can sign in (see loginBlockReason) — except for the very
 *  first account on an empty users table, which bootstraps straight to System
 *  admin/ACTIVE since there is no admin yet to approve it. */
export async function createAccount(name: string, email: string, password: string): Promise<PublicUser> {
  if (await emailExists(email)) throw new Error('An account with that email already exists');
  const isFirstAccount = (await userCount()) === 0;
  const role = isFirstAccount ? SUPER_ADMIN_ROLE : SELF_SIGNUP_ROLE;
  const status = isFirstAccount ? 'ACTIVE' : 'PENDING_APPROVAL';
  const row = await peripheral.create('users', isFirstAccount ? `${name} (self sign-up, bootstrap admin)` : `${name} (self sign-up)`, undefined, status, {
    name, email, role, last_active: new Date().toISOString(),
  });
  if (!row) throw new Error('Could not create account');
  await setPassword(row.id, password);
  return { id: row.id, name, email, role, status };
}

/** Fresh SQLite installs have historically shipped ~16 pre-seeded accounts with
 *  no password at all. Runs on every boot so any such account gets a known
 *  default the moment this column exists, instead of being locked out forever. */
export async function ensureDefaultPasswords(): Promise<void> {
  const rows = await db.prepare('SELECT id FROM users WHERE password_hash IS NULL').all() as { id: string }[];
  if (rows.length === 0) return;
  const hash = hashPassword(DEFAULT_PASSWORD);
  const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  for (const row of rows) await stmt.run(hash, row.id);
}
