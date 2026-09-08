import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as inventory from './inventory.js';
import * as sales from './sales.js';
import * as marketerStock from './marketerStock.js';

beforeAll(async () => { await ensureMigrated(); });

async function makeMarketer() {
  const marketerId = uniqueId('TST-MKT-');
  await sales.createCustomer({ id: marketerId, name: 'Test Jerry', location: null, phone: null, customer_type: 'MARKETER' });
  return marketerId;
}

describe('marketer stock assignment/verification (Section 12)', () => {
  it('Jerry sees "Assigned: 200" before he confirms, and holds nothing until he does', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 200, 'seed for test');
    const marketerId = await makeMarketer();

    const issue = await marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 200, unitPrice: 300 }] });
    expect(await marketerStock.getBalance(marketerId, itemId)).toBe(0);
    const pending = await marketerStock.pendingAssignments(marketerId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ item_id: itemId, assigned_quantity: 200 });

    const verified = await marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verified_by).toBe('Jerry');
    expect(await marketerStock.getBalance(marketerId, itemId)).toBe(200);
    expect(await marketerStock.pendingAssignments(marketerId)).toHaveLength(0);
  });

  it('records Posted By, Verified By, Date, Time, Quantity, Product and Reference', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 50, 'seed for test');
    const marketerId = await makeMarketer();

    const issue = await marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse Clerk', items: [{ itemId, quantity: 50, unitPrice: 100 }] });
    await marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });

    const record = (await marketerStock.getAssignment(issue.id))!;
    expect(record.issued_by).toBe('Test Warehouse Clerk');
    expect(record.verified_by).toBe('Jerry');
    expect(record.verified_at).toBeTruthy();
    expect(record.issued_at).toBeTruthy();

    const items = await marketerStock.listAssignmentItems(issue.id);
    expect(items).toEqual([expect.objectContaining({ item_id: itemId, quantity: 50 })]);
  });

  it('does not require managerial approval to verify — no role/override needed', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 10, 'seed for test');
    const marketerId = await makeMarketer();
    const issue = await marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 10, unitPrice: 10 }] });
    await expect(marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' })).resolves.not.toThrow();
  });

  it('rejects verifying an assignment twice', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 10, 'seed for test');
    const marketerId = await makeMarketer();
    const issue = await marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 10, unitPrice: 10 }] });
    await marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    await expect(marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' })).rejects.toThrow();
  });
});
