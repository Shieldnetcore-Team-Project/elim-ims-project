import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as inventory from './inventory.js';
import * as retailStock from './retailStock.js';
import * as sales from './sales.js';
import * as tillClose from './tillClose.js';

beforeAll(async () => { await ensureMigrated(); });

async function sellCash(itemId: string, quantity: number, unitPrice: number) {
  const customerId = uniqueId('TST-RTL-');
  await sales.createCustomer({ id: customerId, name: 'Test Till Customer', location: null, phone: null, customer_type: 'RETAIL' });
  return await sales.createOrder({
    customerId, channel: 'POS', rep: 'Test Cashier', items: [{ itemId, quantity, unitPrice }],
    payments: [{ method: 'Cash', amount: quantity * unitPrice }],
  });
}

describe('tillClose (Section 23)', () => {
  it('computes expected closing from opening + cash received - payments + adjustments, and flags the difference', async () => {
    // Cash Sales/Received are read live for the whole business day (Section
    // 23 doesn't partition POS sales by till), so this baselines against
    // whatever's already on record today rather than assuming a clean slate
    // shared with every other test in this file.
    const before = await tillClose.todayCashFigures();

    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 100, 'seed for test');
    const rtiTc = await retailStock.dispatchToRetail({ issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 100, unitCost: 50 }] });
    await retailStock.confirmIntake(rtiTc.id, { confirmedBy: 'Test Retail' });
    await sellCash(itemId, 10, 200); // 2,000 cash sale

    const expectedCashReceived = before.cashReceived + 2000;
    const expectedClosing = 5000 + expectedCashReceived - 300 + 100; // opening + cash received - payments + adjustments
    const actualClosing = expectedClosing - 100; // deliberately short by 100

    const till = uniqueId('TST-TILL-');
    const close = await tillClose.closeTill({ till, openingBalance: 5000, payments: 300, adjustments: 100, actualClosing, closedBy: 'Test Cashier' });

    expect(close.cash_received).toBe(expectedCashReceived);
    expect(close.expected_closing).toBe(expectedClosing);
    expect(close.actual_closing).toBe(actualClosing);
    expect(close.difference).toBe(-100);
    expect(close.status).toBe('CLOSED');
  });

  it('cannot close the same till twice for the same business date', async () => {
    const till = uniqueId('TST-TILL-');
    await tillClose.closeTill({ till, openingBalance: 1000, payments: 0, adjustments: 0, actualClosing: 1000, closedBy: 'Test Cashier' });
    await expect(tillClose.closeTill({ till, openingBalance: 1000, payments: 0, adjustments: 0, actualClosing: 1000, closedBy: 'Test Cashier' })).rejects.toThrow();
    expect(await tillClose.isTillClosed(till)).toBe(true);
  });

  it('review is a distinct step from close, and cannot be repeated', async () => {
    const till = uniqueId('TST-TILL-');
    const close = await tillClose.closeTill({ till, openingBalance: 1000, payments: 0, adjustments: 0, actualClosing: 1000, closedBy: 'Test Cashier' });
    expect(close.reviewed_by).toBeNull();

    const reviewed = await tillClose.reviewTill(close.id, { reviewedBy: 'Test Supervisor' });
    expect(reviewed.status).toBe('REVIEWED');
    expect(reviewed.reviewed_by).toBe('Test Supervisor');
    await expect(tillClose.reviewTill(close.id, { reviewedBy: 'Test Supervisor' })).rejects.toThrow();
  });
});
