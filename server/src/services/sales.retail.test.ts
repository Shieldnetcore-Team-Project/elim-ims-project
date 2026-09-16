import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as sales from './sales.js';
import * as retailStock from './retailStock.js';
import * as inventory from './inventory.js';

beforeAll(async () => { await ensureMigrated(); });

describe('retail (POS) sales post immediately (Section 9 — no approval gate)', () => {
  it('posts to Retail stock and settles to PAID in the same call, no AWAITING_APPROVAL step', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 20, 'seed for test');
    const rti1 = await retailStock.dispatchToRetail({ issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 20, unitCost: 100 }] });
    await retailStock.confirmIntake(rti1.id, { confirmedBy: 'Test Retail' });
    const customerId = uniqueId('TST-RTL-');
    await sales.createCustomer({ id: customerId, name: 'Test Walk-in', location: null, phone: null, customer_type: 'RETAIL' });

    const order = await sales.createOrder({
      customerId, channel: 'POS', rep: 'Test Cashier',
      items: [{ itemId, quantity: 5, unitPrice: 150 }],
      payments: [{ method: 'Cash', amount: 750 }],
    });

    expect(order.status).toBe('PAID');
    expect(await retailStock.getBalance(itemId)).toBe(15);
  });

  it('allows an anonymous walk-in (no customer profile) and captures a typed walk-in name', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 10, 'seed for test');
    const rti2 = await retailStock.dispatchToRetail({ issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 10, unitCost: 100 }] });
    await retailStock.confirmIntake(rti2.id, { confirmedBy: 'Test Retail' });

    const anon = await sales.createOrder({
      channel: 'POS', rep: 'Test Cashier', items: [{ itemId, quantity: 1, unitPrice: 150 }],
    });
    expect(anon.status).toBe('PAID');
    expect(anon.customer_id).toBeNull();

    const named = await sales.createOrder({
      channel: 'POS', rep: 'Test Cashier', walkInName: 'Ada Walk-in',
      items: [{ itemId, quantity: 2, unitPrice: 150 }],
    });
    const listed = (await sales.listOrders('POS')).find(o => o.id === named.id) as { customer_name: string } | undefined;
    expect(listed?.customer_name).toBe('Ada Walk-in');
  });
});
