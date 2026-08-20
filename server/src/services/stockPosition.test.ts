import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as stockPosition from './stockPosition.js';
import * as inventory from './inventory.js';
import * as sales from './sales.js';
import * as marketerStock from './marketerStock.js';

beforeAll(() => ensureMigrated());

function lineFor(itemId: string) {
  return stockPosition.getStockPosition().find(l => l.item_id === itemId)!;
}

describe('stockPosition (marketer trust stock)', () => {
  it('separates physical, assigned and pending-return instead of collapsing them into one balance', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    const marketerId = uniqueId('TST-MKT-');
    sales.createCustomer({ id: marketerId, name: 'Test Marketer', location: null, phone: null, customer_type: 'MARKETER' });

    inventory.adjustStock(itemId, 100, 'seed for test');
    expect(lineFor(itemId)).toMatchObject({ physical_stock: 100, assigned_stock: 0, pending_return: 0, available_stock: 100 });

    // Issue 40 to the marketer: physical leaves the warehouse immediately, and
    // assigned rises too (Section 12: it's "Assigned" from the moment the
    // warehouse posts it, whether or not the marketer has confirmed yet).
    const issue = marketerStock.issueStock({ marketerId, items: [{ itemId, quantity: 40, unitPrice: 10 }], issuedBy: 'Test Issuer' });
    expect(lineFor(itemId)).toMatchObject({ physical_stock: 60, assigned_stock: 40, pending_return: 0, available_stock: 60 });

    // The marketer confirms receipt — assigned_stock is unchanged in total
    // (it now comes from their held balance instead of the pending-assignment
    // bucket), but they can now do things like claim a return against it.
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    expect(lineFor(itemId)).toMatchObject({ physical_stock: 60, assigned_stock: 40, pending_return: 0, available_stock: 60 });

    // Marketer claims a return of 15: leaves their assigned balance immediately,
    // but must NOT enter physical stock yet — it sits in pending_return instead.
    const ret = marketerStock.recordReturn({ marketerId, items: [{ itemId, quantity: 15 }], actor: 'Test Marketer Rep' });
    expect(lineFor(itemId)).toMatchObject({ physical_stock: 60, assigned_stock: 25, pending_return: 15, available_stock: 60 });

    // Warehouse verifies what actually arrived: pending_return clears, physical rises.
    marketerStock.verifyReturn(ret.id, { verifiedBy: 'Test Warehouse Manager', lines: [{ itemId, verifiedQuantity: 15 }] });
    expect(lineFor(itemId)).toMatchObject({ physical_stock: 75, assigned_stock: 25, pending_return: 0, available_stock: 75 });
  });

  it('reflects a verified shortage — claimed quantity never silently becomes physical stock', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    const marketerId = uniqueId('TST-MKT-');
    sales.createCustomer({ id: marketerId, name: 'Test Marketer 2', location: null, phone: null, customer_type: 'MARKETER' });

    inventory.adjustStock(itemId, 50, 'seed for test');
    const issue = marketerStock.issueStock({ marketerId, items: [{ itemId, quantity: 20, unitPrice: 10 }], issuedBy: 'Test Issuer' });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: 'Jerry' });
    const ret = marketerStock.recordReturn({ marketerId, items: [{ itemId, quantity: 10 }], actor: 'Test Marketer Rep' });
    expect(lineFor(itemId)).toMatchObject({ physical_stock: 30, assigned_stock: 10, pending_return: 10, available_stock: 30 });

    // Only 6 of the claimed 10 actually arrive.
    marketerStock.verifyReturn(ret.id, { verifiedBy: 'Test Warehouse Manager', lines: [{ itemId, verifiedQuantity: 6 }] });
    expect(lineFor(itemId)).toMatchObject({ physical_stock: 36, assigned_stock: 10, pending_return: 0, available_stock: 36 });
  });
});
