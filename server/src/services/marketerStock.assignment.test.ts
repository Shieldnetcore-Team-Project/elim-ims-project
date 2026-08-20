import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as inventory from './inventory.js';
import * as sales from './sales.js';
import * as marketerStock from './marketerStock.js';

beforeAll(() => ensureMigrated());

function makeMarketer() {
  const marketerId = uniqueId('TST-MKT-');
  sales.createCustomer({ id: marketerId, name: 'Test Jerry', location: null, phone: null, customer_type: 'MARKETER' });
  return marketerId;
}

describe('marketer stock assignment/verification (Section 12)', () => {
  it('Jerry sees "Assigned: 200" before he confirms, and holds nothing until he does', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 200, 'seed for test');
    const marketerId = makeMarketer();

    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 200, unitPrice: 300 }] });
    expect(marketerStock.getBalance(marketerId, itemId)).toBe(0);
    const pending = marketerStock.pendingAssignments(marketerId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ item_id: itemId, assigned_quantity: 200 });

    const verified = marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verified_by).toBe('Jerry');
    expect(marketerStock.getBalance(marketerId, itemId)).toBe(200);
    expect(marketerStock.pendingAssignments(marketerId)).toHaveLength(0);
  });

  it('records Posted By, Verified By, Date, Time, Quantity, Product and Reference', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 50, 'seed for test');
    const marketerId = makeMarketer();

    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse Clerk', items: [{ itemId, quantity: 50, unitPrice: 100 }] });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });

    const record = marketerStock.getAssignment(issue.id)!;
    expect(record.issued_by).toBe('Test Warehouse Clerk');
    expect(record.verified_by).toBe('Jerry');
    expect(record.verified_at).toBeTruthy();
    expect(record.issued_at).toBeTruthy();

    const items = marketerStock.listAssignmentItems(issue.id);
    expect(items).toEqual([expect.objectContaining({ item_id: itemId, quantity: 50 })]);
  });

  it('does not require managerial approval to verify — no role/override needed', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 10, 'seed for test');
    const marketerId = makeMarketer();
    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 10, unitPrice: 10 }] });
    expect(() => marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' })).not.toThrow();
  });

  it('rejects verifying an assignment twice', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 10, 'seed for test');
    const marketerId = makeMarketer();
    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 10, unitPrice: 10 }] });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    expect(() => marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' })).toThrow();
  });
});
