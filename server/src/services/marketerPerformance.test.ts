import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as inventory from './inventory.js';
import * as sales from './sales.js';
import * as marketerStock from './marketerStock.js';
import * as marketerCustomers from './marketerCustomers.js';
import * as marketerPerformance from './marketerPerformance.js';

beforeAll(() => ensureMigrated());

function makeMarketer() {
  const marketerId = uniqueId('TST-MKT-');
  sales.createCustomer({ id: marketerId, name: 'Test Performance Marketer', location: null, phone: null, customer_type: 'MARKETER' });
  return marketerId;
}

function setCommissionRate(percent: string) {
  db.prepare(`
    INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Marketer commission rate', 'test', ?, 'Test', 'ACTIVE')
    ON CONFLICT(id) DO UPDATE SET value = excluded.value
  `).run(percent);
}

function rowFor(marketerId: string) {
  return marketerPerformance.performanceReport().find(r => r.marketer_id === marketerId)!;
}

describe('marketer commission and performance', () => {
  it('does not commission unrecovered credit — only Cash + Recovered counts', () => {
    setCommissionRate('10%');
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 1000, 'seed for test');
    const marketerId = makeMarketer();

    const cashCustomer = marketerCustomers.createCustomer({ marketerId, name: 'Cash Customer', creditLimit: 0, actor: 'Test' });
    const creditCustomer = marketerCustomers.createCustomer({ marketerId, name: 'Credit Customer', creditLimit: 1000000, actor: 'Test' });

    // Give the marketer stock to sell from.
    const stockIssue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 500, unitPrice: 1000 }] });
    marketerStock.verifyAssignment(stockIssue.id, { verifiedBy: 'Jerry' });

    // Cash sale: 100 units at 1000 = 100,000, fully paid.
    marketerCustomers.recordCustomerSale({ marketerId, customerId: cashCustomer.id, items: [{ itemId, quantity: 100 }], cashReceived: 100000, actor: 'Test' });
    // Credit sale: 200 units at 1000 = 200,000, only 50,000 paid up front -> 150,000 unrecovered.
    marketerCustomers.recordCustomerSale({ marketerId, customerId: creditCustomer.id, items: [{ itemId, quantity: 200 }], cashReceived: 50000, actor: 'Test' });

    const row = rowFor(marketerId);
    expect(row.cash_sales).toBe(100000);
    expect(row.credit_sales).toBe(200000);
    expect(row.outstanding_credit).toBe(150000);
    expect(row.total_sales).toBe(300000);
    expect(row.eligible_sales).toBe(300000);
    // Commissionable = Cash (100,000) + Recovered credit (200,000 - 150,000 = 50,000) = 150,000.
    expect(row.commissionable_sales).toBe(150000);
    expect(row.commission_rate).toBe(10);
    expect(row.commission).toBe(15000);
  });

  it('commission rises once outstanding credit is later recovered', () => {
    setCommissionRate('10%');
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 100, 'seed for test');
    const marketerId = makeMarketer();
    const creditCustomer = marketerCustomers.createCustomer({ marketerId, name: 'Credit Customer 2', creditLimit: 1000000, actor: 'Test' });
    const stockIssue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 50, unitPrice: 1000 }] });
    marketerStock.verifyAssignment(stockIssue.id, { verifiedBy: 'Jerry' });

    marketerCustomers.recordCustomerSale({ marketerId, customerId: creditCustomer.id, items: [{ itemId, quantity: 50 }], cashReceived: 0, actor: 'Test' });
    expect(rowFor(marketerId).commissionable_sales).toBe(0);

    marketerCustomers.recordPayment({ customerId: creditCustomer.id, amount: 50000, method: 'Cash', actor: 'Test' });
    const row = rowFor(marketerId);
    expect(row.outstanding_credit).toBe(0);
    expect(row.commissionable_sales).toBe(50000);
    expect(row.commission).toBe(5000);
  });

  it('reads whatever percentage is configured in Settings, not a hard-coded number', () => {
    setCommissionRate('7.5%');
    expect(marketerPerformance.commissionRatePercent()).toBe(7.5);
    setCommissionRate('12%');
    expect(marketerPerformance.commissionRatePercent()).toBe(12);
  });

  it('Section 39: scopes activity to a date range while keeping Outstanding Credit live', () => {
    setCommissionRate('10%');
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 200, 'seed for test');
    const marketerId = makeMarketer();
    const customer = marketerCustomers.createCustomer({ marketerId, name: 'Range Customer', creditLimit: 1000000, actor: 'Test' });
    const stockIssue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 100, unitPrice: 1000 }] });
    marketerStock.verifyAssignment(stockIssue.id, { verifiedBy: 'Jerry' });

    // A cash sale today, fully paid.
    marketerCustomers.recordCustomerSale({ marketerId, customerId: customer.id, items: [{ itemId, quantity: 40 }], cashReceived: 40000, actor: 'Test' });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    // In range: today's sale is visible.
    const inRange = marketerPerformance.performanceReport({ from: today, to: tomorrow }).find(r => r.marketer_id === marketerId)!;
    expect(inRange.cash_sales).toBe(40000);
    expect(inRange.commissionable_sales).toBe(40000);

    // Out of range: activity figures are zero for a window that excludes today.
    const outOfRange = marketerPerformance.performanceReport({ from: yesterday, to: yesterday }).find(r => r.marketer_id === marketerId)!;
    expect(outOfRange.cash_sales).toBe(0);
    expect(outOfRange.commissionable_sales).toBe(0);
    // Outstanding credit stays live/all-time regardless of the window (there is none here, but the field itself is unaffected by range).
    expect(outOfRange.outstanding_credit).toBe(inRange.outstanding_credit);
  });
});
