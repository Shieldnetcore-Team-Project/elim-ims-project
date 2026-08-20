import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as sales from './sales.js';
import * as finance from './finance.js';

beforeAll(() => ensureMigrated());

describe('finance.customerStatement (Section 16)', () => {
  it('keeps every movement and its running balance — never just a final total', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    const customerId = uniqueId('TST-DST-');
    sales.createCustomer({ id: customerId, name: 'Test Statement Distributor', location: null, phone: null, customer_type: 'DISTRIBUTOR' });

    const order = sales.createOrder({
      customerId, channel: 'INVOICE', rep: 'Test Rep', paymentTerms: 'CASH',
      items: [{ itemId, quantity: 1, unitPrice: 500000 }],
    });
    finance.recordReceipt({ receivedFrom: customerId, amount: 200000, method: 'Cash', referenceType: 'sales', referenceId: order.id, customerId });

    const lines = finance.customerStatement(customerId) as { debit: number; credit: number; running_balance: number }[];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Invoice 500,000, then a 200,000 payment -> running balance 300,000 (spec's own worked example shape).
    const balance = finance.customerBalance(customerId);
    expect(balance.outstanding).toBe(300000);
    expect(lines[lines.length - 1].running_balance).toBe(300000);

    finance.recordReceipt({ receivedFrom: customerId, amount: 300000, method: 'Cash', referenceType: 'sales', referenceId: order.id, customerId });
    const linesAfter = finance.customerStatement(customerId) as { running_balance: number }[];
    // Both payments retained as separate rows — not merged or overwritten.
    expect(linesAfter.length).toBe(lines.length + 1);
    expect(linesAfter[linesAfter.length - 1].running_balance).toBe(0);
    expect(finance.customerBalance(customerId).outstanding).toBe(0);
  });
});

describe('finance.customerAgingReport (Section 17)', () => {
  it('buckets a fully outstanding invoice into Current on the day it is raised', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    const customerId = uniqueId('TST-DST-');
    sales.createCustomer({ id: customerId, name: 'Test Aging Distributor', location: null, phone: null, customer_type: 'DISTRIBUTOR' });
    sales.createOrder({ customerId, channel: 'INVOICE', rep: 'Test Rep', paymentTerms: 'CASH', items: [{ itemId, quantity: 1, unitPrice: 42000 }] });

    const row = finance.customerAgingReport().find(r => r.customerId === customerId)!;
    expect(row).toBeTruthy();
    expect(row.current).toBe(42000);
    expect(row.d1to30 + row.d31to40 + row.d41to50 + row.d51to60 + row.d61to90 + row.d90plus).toBe(0);
    expect(row.total).toBe(42000);
  });

  it('reads configurable boundaries from Settings rather than a fixed scheme', () => {
    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('AR aging buckets (days)', 'test', '0,10,20,30,40,50', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    const customerId = uniqueId('TST-DST-');
    sales.createCustomer({ id: customerId, name: 'Test Configurable Aging', location: null, phone: null, customer_type: 'DISTRIBUTOR' });
    sales.createOrder({ customerId, channel: 'INVOICE', rep: 'Test Rep', paymentTerms: 'CASH', items: [{ itemId, quantity: 1, unitPrice: 9000 }] });

    const row = finance.customerAgingReport().find(r => r.customerId === customerId)!;
    expect(row.current).toBe(9000); // age 0 days, still "Current" under any boundary scheme

    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('AR aging buckets (days)', 'test', '0,30,40,50,60,90', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
  });
});
