import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as inventory from './inventory.js';
import * as sales from './sales.js';
import * as marketerStock from './marketerStock.js';
import * as marketerReconciliation from './marketerReconciliation.js';

beforeAll(() => ensureMigrated());

function makeMarketer() {
  const marketerId = uniqueId('TST-MKT-');
  sales.createCustomer({ id: marketerId, name: 'Test Reconciliation Marketer', location: null, phone: null, customer_type: 'MARKETER' });
  return marketerId;
}

function lineFor(marketerId: string, itemId: string) {
  return marketerReconciliation.reconciliation(marketerId).find(l => l.item_id === itemId)!;
}

describe('end-of-day marketer reconciliation', () => {
  it('the worked example: Assigned 2,000 = Sold 1,600 + Returned 400 + Remaining 0 -> BALANCED', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 2000, 'seed for test');
    const marketerId = makeMarketer();

    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 2000, unitPrice: 10 }] });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    marketerStock.recordSale({ marketerId, actor: 'Jerry', cashReceived: 0, items: [{ itemId, quantity: 1600 }] });
    const ret = marketerStock.recordReturn({ marketerId, actor: 'Jerry', items: [{ itemId, quantity: 400 }] });
    marketerStock.verifyReturn(ret.id, { verifiedBy: 'Warehouse Clerk', lines: [{ itemId, verifiedQuantity: 400 }] });

    const line = lineFor(marketerId, itemId);
    expect(line).toMatchObject({ assigned: 2000, sold: 1600, returned: 400, remaining: 0, discrepancy: 0, status: 'BALANCED' });
    expect(line.assigned).toBe(line.sold + line.returned + line.remaining);
  });

  it('flags PENDING_VERIFICATION while the marketer has not confirmed a warehouse assignment', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 500, 'seed for test');
    const marketerId = makeMarketer();
    marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 500, unitPrice: 10 }] });

    const line = lineFor(marketerId, itemId);
    expect(line.status).toBe('PENDING_VERIFICATION');
    expect(line.pending_assignment).toBe(500);
    expect(line.assigned).toBe(0); // not yet confirmed, so not counted as held assigned stock
  });

  it('flags PENDING_RETURN while a claimed return has not been warehouse-verified', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 300, 'seed for test');
    const marketerId = makeMarketer();
    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 300, unitPrice: 10 }] });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    marketerStock.recordReturn({ marketerId, actor: 'Jerry', items: [{ itemId, quantity: 100 }] });

    const line = lineFor(marketerId, itemId);
    expect(line.status).toBe('PENDING_RETURN');
    expect(line.pending_return).toBe(100);
    expect(line.remaining).toBe(200);
  });

  it('flags SHORT when a verified return comes back for less than claimed', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 300, 'seed for test');
    const marketerId = makeMarketer();
    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 300, unitPrice: 10 }] });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    const ret = marketerStock.recordReturn({ marketerId, actor: 'Jerry', items: [{ itemId, quantity: 100 }] });
    marketerStock.verifyReturn(ret.id, { verifiedBy: 'Warehouse Clerk', lines: [{ itemId, verifiedQuantity: 80 }] });

    const line = lineFor(marketerId, itemId);
    expect(line.status).toBe('SHORT');
    expect(line.discrepancy).toBe(20);
  });

  it('flags EXCESS when a verified return comes back for more than claimed', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 300, 'seed for test');
    const marketerId = makeMarketer();
    const issue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 300, unitPrice: 10 }] });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    const ret = marketerStock.recordReturn({ marketerId, actor: 'Jerry', items: [{ itemId, quantity: 100 }] });
    marketerStock.verifyReturn(ret.id, { verifiedBy: 'Warehouse Clerk', lines: [{ itemId, verifiedQuantity: 115 }] });

    const line = lineFor(marketerId, itemId);
    expect(line.status).toBe('EXCESS');
    expect(line.discrepancy).toBe(-15);
  });
});
