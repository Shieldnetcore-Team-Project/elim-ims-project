import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem } from '../test/fixtures.js';
import * as sales from './sales.js';
import * as inventory from './inventory.js';

beforeAll(() => ensureMigrated());

function accountNet(account: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM ledger WHERE account = ?`).get(account) as { v: number }).v;
}

describe('sales.reverseOrder', () => {
  it('undoes the inventory OUT and AR/Revenue ledger effect of an unsettled credit order', () => {
    const itemId = makeItem();
    const before = { onHand: inventory.getBalance(itemId), ar: accountNet('Accounts receivable'), revenue: accountNet('Sales revenue') };

    // INVOICE channel with no customerId defaults to RETAIL/CREDIT — posts
    // immediately (not AWAITING_APPROVAL) but settles nothing, so AR stays open.
    const order = sales.createOrder({ channel: 'INVOICE', rep: 'Test Rep', items: [{ itemId, quantity: 3, unitPrice: 100 }] });
    const afterCreate = { onHand: inventory.getBalance(itemId), ar: accountNet('Accounts receivable'), revenue: accountNet('Sales revenue') };
    expect(afterCreate.onHand - before.onHand).toBe(-3);
    expect(afterCreate.ar - before.ar).toBe(300);
    // Sales revenue is a credit-normal account — accountNet (debit - credit)
    // goes *down* by 300 when 300 of revenue is posted, not up.
    expect(afterCreate.revenue - before.revenue).toBe(-300);

    sales.reverseOrder(order.id, { reason: 'unit test reversal of a sales order', actor: 'Test Actor' });
    const afterReverse = { onHand: inventory.getBalance(itemId), ar: accountNet('Accounts receivable'), revenue: accountNet('Sales revenue') };
    expect(afterReverse.onHand).toBe(before.onHand);
    expect(afterReverse.ar).toBe(before.ar);
    expect(afterReverse.revenue).toBe(before.revenue);

    expect(() => sales.reverseOrder(order.id, { reason: 'a second reversal attempt', actor: 'Test Actor' })).toThrow();
  });

  it('refuses to reverse an order that never posted (AWAITING_APPROVAL)', () => {
    // A Distributor on CREDIT terms requires approval before anything posts —
    // reject the credit sale instead, which reverseOrder itself should refuse to touch.
    const itemId = makeItem();
    const customerId = `TST-CUS-${Date.now()}`;
    db.prepare(`INSERT INTO customers (id, name, customer_type) VALUES (?,?, 'DISTRIBUTOR')`).run(customerId, 'Test Distributor');
    const order = sales.createOrder({ channel: 'INVOICE', rep: 'Test Rep', customerId, paymentTerms: 'CREDIT', items: [{ itemId, quantity: 1, unitPrice: 50 }] });
    expect(order.status).toBe('AWAITING_APPROVAL');
    expect(() => sales.reverseOrder(order.id, { reason: 'should be refused, not posted yet', actor: 'Test Actor' })).toThrow();
  });
});
