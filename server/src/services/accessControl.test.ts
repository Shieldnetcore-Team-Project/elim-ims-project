import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import { db } from '../db/client.js';
import * as accessControl from './accessControl.js';

beforeAll(async () => { await ensureMigrated(); });

async function makeUser(role: string): Promise<string> {
  const id = uniqueId('TST-USR-');
  await db.prepare(`INSERT INTO users (id, name, role, status) VALUES (?,?,?,'ACTIVE')`).run(id, `User ${id}`, role);
  return id;
}

describe('accessControl.requireApproval (dual control)', () => {
  it('passes for System admin and for the legacy fallback role, with no explicit grant', async () => {
    const admin = await makeUser('System admin');
    const manager = await makeUser('Sales manager');
    await expect(accessControl.requireApproval(admin, 'sales-reverse', ['Sales manager'], 'Sales reversals')).resolves.toMatchObject({ id: admin });
    await expect(accessControl.requireApproval(manager, 'sales-reverse', ['Sales manager'], 'Sales reversals')).resolves.toMatchObject({ id: manager });
  });

  it('passes for a user without the role once the capability is granted, and fails once removed', async () => {
    const clerk = await makeUser('Accountant');
    await expect(accessControl.requireApproval(clerk, 'sales-reverse', ['Sales manager'], 'Sales reversals')).rejects.toThrow();

    await accessControl.setAccess(clerk, ['sales', 'sales-reverse'], 'Test Admin');
    await expect(accessControl.requireApproval(clerk, 'sales-reverse', ['Sales manager'], 'Sales reversals')).resolves.toMatchObject({ id: clerk });

    await accessControl.setAccess(clerk, ['sales'], 'Test Admin'); // grant removed
    await expect(accessControl.requireApproval(clerk, 'sales-reverse', ['Sales manager'], 'Sales reversals')).rejects.toThrow();
  });

  it('rejects an unknown or missing user', async () => {
    await expect(accessControl.requireApproval(undefined, 'finance-reverse', ['Finance manager'], 'Finance reversals')).rejects.toThrow();
    await expect(accessControl.requireApproval('nope', 'finance-reverse', ['Finance manager'], 'Finance reversals')).rejects.toThrow();
  });
});

describe('accessControl.requireSuperAdmin (purchase order approval)', () => {
  it('passes for System admin only — no capability grant can substitute', async () => {
    const admin = await makeUser('System admin');
    const manager = await makeUser('Procurement Manager');
    await accessControl.setAccess(manager, ['procurement-approve'], 'Test Admin');

    await expect(accessControl.requireSuperAdmin(admin, 'approve a purchase order')).resolves.toMatchObject({ id: admin });
    await expect(accessControl.requireSuperAdmin(manager, 'approve a purchase order')).rejects.toThrow();
  });

  it('rejects an unknown or missing user', async () => {
    await expect(accessControl.requireSuperAdmin(undefined, 'approve a purchase order')).rejects.toThrow();
    await expect(accessControl.requireSuperAdmin('nope', 'approve a purchase order')).rejects.toThrow();
  });
});
