import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as sales from './sales.js';
import * as retailStock from './retailStock.js';
import * as inventory from './inventory.js';

beforeAll(() => ensureMigrated());

describe('retail (POS) sales post immediately (Section 9 — no approval gate)', () => {
  it('posts to Retail stock and settles to PAID in the same call, no AWAITING_APPROVAL step', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 20, 'seed for test');
    retailStock.postIntake({ issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 20, unitCost: 100 }] });
    const customerId = uniqueId('TST-RTL-');
    sales.createCustomer({ id: customerId, name: 'Test Walk-in', location: null, phone: null, customer_type: 'RETAIL' });

    const order = sales.createOrder({
      customerId, channel: 'POS', rep: 'Test Cashier',
      items: [{ itemId, quantity: 5, unitPrice: 150 }],
      payments: [{ method: 'Cash', amount: 750 }],
    });

    expect(order.status).toBe('PAID');
    expect(retailStock.getBalance(itemId)).toBe(15);
  });

  it('still requires a customer for a retail sale', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 5, 'seed for test');
    retailStock.postIntake({ issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 5, unitCost: 100 }] });
    expect(() => sales.createOrder({
      channel: 'POS', rep: 'Test Cashier', items: [{ itemId, quantity: 1, unitPrice: 150 }],
    })).toThrow();
  });
});
