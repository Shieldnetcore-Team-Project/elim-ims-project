import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as inventory from './inventory.js';
import * as sales from './sales.js';
import * as marketerStock from './marketerStock.js';
import * as marketerCustomers from './marketerCustomers.js';

beforeAll(() => ensureMigrated());

function makeMarketer() {
  const marketerId = uniqueId('TST-MKT-');
  sales.createCustomer({ id: marketerId, name: 'Test Credit Marketer', location: null, phone: null, customer_type: 'MARKETER' });
  return marketerId;
}

describe('marketerCustomers.creditTransactions (Section 15)', () => {
  it('carries Customer, Marketer, Invoice, Amount, Credit Limit and moves through CREDIT -> PARTIALLY_PAID -> FULLY_PAID', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 100, 'seed for test');
    const marketerId = makeMarketer();
    const stockIssue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 50, unitPrice: 1000 }] });
    marketerStock.verifyAssignment(stockIssue.id, { verifiedBy: 'Jerry' });
    const customer = marketerCustomers.createCustomer({ marketerId, name: 'Test Field Customer', creditLimit: 100000, actor: 'Test' });

    const sale = marketerCustomers.recordCustomerSale({ marketerId, customerId: customer.id, items: [{ itemId, quantity: 10 }], cashReceived: 0, actor: 'Test' });

    let row = marketerCustomers.creditTransactions().find(t => t.id === sale.id)!;
    expect(row.customer_name).toBe('Test Field Customer');
    expect(row.marketer_id).toBe(marketerId);
    expect(row.amount).toBe(10000);
    expect(row.credit_limit).toBe(100000);
    expect(row.amount_paid).toBe(0);
    expect(row.balance).toBe(10000);
    expect(row.recovery_status).toBe('CREDIT');

    marketerCustomers.recordPayment({ customerId: customer.id, saleId: sale.id, amount: 4000, method: 'Cash', actor: 'Test' });
    row = marketerCustomers.creditTransactions().find(t => t.id === sale.id)!;
    expect(row.amount_paid).toBe(4000);
    expect(row.balance).toBe(6000);
    expect(row.recovery_status).toBe('PARTIALLY_PAID');

    marketerCustomers.recordPayment({ customerId: customer.id, saleId: sale.id, amount: 6000, method: 'Cash', actor: 'Test' });
    row = marketerCustomers.creditTransactions().find(t => t.id === sale.id)!;
    expect(row.balance).toBe(0);
    expect(row.recovery_status).toBe('FULLY_PAID');
  });

  it('flags OVERDUE once the due date has passed, even ahead of a partial payment', () => {
    const itemId = makeItem({ type: 'FINISHED_GOOD' });
    inventory.adjustStock(itemId, 50, 'seed for test');
    const marketerId = makeMarketer();
    const stockIssue = marketerStock.issueStock({ marketerId, issuedBy: 'Test Warehouse', items: [{ itemId, quantity: 20, unitPrice: 500 }] });
    marketerStock.verifyAssignment(stockIssue.id, { verifiedBy: 'Jerry' });
    const customer = marketerCustomers.createCustomer({ marketerId, name: 'Overdue Customer', creditLimit: 50000, actor: 'Test' });
    const sale = marketerCustomers.recordCustomerSale({ marketerId, customerId: customer.id, items: [{ itemId, quantity: 10 }], cashReceived: 0, actor: 'Test' });

    const pastDue = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    marketerCustomers.assignFollowUp(sale.id, { dueDate: pastDue, actor: 'Test' });

    const row = marketerCustomers.creditTransactions().find(t => t.id === sale.id)!;
    expect(row.due_date).toBe(pastDue);
    expect(row.recovery_status).toBe('OVERDUE');
  });
});
