import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as sales from './sales.js';
import * as retailStock from './retailStock.js';
import * as inventory from './inventory.js';
import * as retailExchanges from './retailExchanges.js';

beforeAll(() => ensureMigrated());

function seedRetailSale(quantity: number, unitPrice: number) {
  const itemId = makeItem({ type: 'FINISHED_GOOD' });
  inventory.adjustStock(itemId, 1000, 'seed for test');
  retailStock.postIntake({ issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 1000, unitCost: 100 }] });
  const customerId = uniqueId('TST-RTL-');
  sales.createCustomer({ id: customerId, name: 'Test Walk-in', location: null, phone: null, customer_type: 'RETAIL' });
  const order = sales.createOrder({
    customerId, channel: 'POS', rep: 'Test Cashier',
    items: [{ itemId, quantity, unitPrice }],
    payments: [{ method: 'Cash', amount: quantity * unitPrice }],
  });
  return { itemId, customerId, order };
}

describe('retail return / exchange (Section 10)', () => {
  it('preserves the original sale — a plain return restores Retail stock without touching it', () => {
    const { itemId, order } = seedRetailSale(250, 200);
    const before = retailStock.getBalance(itemId);

    const result = retailExchanges.recordExchange({
      originalSalesId: order.id, returns: [{ itemId, quantity: 100 }],
      reason: 'Customer changed their mind', staff: 'Test Cashier',
    });

    expect(result.newSalesId).toBeNull();
    expect(retailStock.getBalance(itemId)).toBe(before + 100);
    // Original sale itself is untouched.
    expect(sales.getOrder(order.id)!.status).toBe('PAID');
    expect(sales.listItemsFor(order.id).find(i => i.item_id === itemId)!.quantity).toBe(250);
  });

  it('supports 250 -> 375 as a return-and-exchange linked by a new transaction reference', () => {
    const { itemId, order } = seedRetailSale(250, 200);

    const result = retailExchanges.recordExchange({
      originalSalesId: order.id, returns: [{ itemId, quantity: 250 }],
      reason: 'Customer wants 375 instead of 250', staff: 'Test Cashier',
      newSaleItems: [{ itemId, quantity: 375, unitPrice: 200 }],
      newSalePayments: [{ method: 'Cash', amount: 75000 }],
    });

    expect(result.newSalesId).not.toBeNull();
    const newOrder = sales.getOrder(result.newSalesId!)!;
    expect(newOrder.status).toBe('PAID');
    expect(sales.listItemsFor(newOrder.id)[0].quantity).toBe(375);

    const exchange = retailExchanges.getExchange(result.id)!;
    expect(exchange.original_sales_id).toBe(order.id);
    expect(exchange.new_sales_id).toBe(newOrder.id);
    expect(retailExchanges.listItemsFor(result.id)[0].quantity_returned).toBe(250);
  });

  it('blocks returning more than was sold, even across two partial returns', () => {
    const { itemId, order } = seedRetailSale(100, 50);
    retailExchanges.recordExchange({ originalSalesId: order.id, returns: [{ itemId, quantity: 60 }], reason: 'Partial return 1', staff: 'Test Cashier' });
    expect(() => retailExchanges.recordExchange({
      originalSalesId: order.id, returns: [{ itemId, quantity: 41 }], reason: 'Partial return 2', staff: 'Test Cashier',
    })).toThrow();
  });

  it('requires a reason and rejects a return against a sale that is not a completed retail sale', () => {
    const { itemId, order } = seedRetailSale(10, 50);
    expect(() => retailExchanges.recordExchange({
      originalSalesId: order.id, returns: [{ itemId, quantity: 1 }], reason: '', staff: 'Test Cashier',
    })).toThrow();

    const invoiceOrder = sales.createOrder({ channel: 'INVOICE', rep: 'Test Rep', items: [{ itemId, quantity: 1, unitPrice: 50 }] });
    expect(() => retailExchanges.recordExchange({
      originalSalesId: invoiceOrder.id, returns: [{ itemId, quantity: 1 }], reason: 'Wrong channel', staff: 'Test Cashier',
    })).toThrow();
  });
});
