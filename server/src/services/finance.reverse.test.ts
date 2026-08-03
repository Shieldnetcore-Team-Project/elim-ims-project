import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeSupplier } from '../test/fixtures.js';
import * as finance from './finance.js';

beforeAll(() => ensureMigrated());

function accountNet(account: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM ledger WHERE account = ?`).get(account) as { v: number }).v;
}

describe('finance.reversePayment', () => {
  it('nets the ledger back to its pre-payment balance without touching the original row', () => {
    const supplierId = makeSupplier();
    const before = { ap: accountNet('Accounts payable'), cash: accountNet('Cash/Bank') };

    const payment = finance.recordPayment({ paidTo: 'Test Supplier', amount: 5000, method: 'Cash', supplierId });
    const afterPay = { ap: accountNet('Accounts payable'), cash: accountNet('Cash/Bank') };
    expect(afterPay.ap - before.ap).toBe(5000);
    expect(afterPay.cash - before.cash).toBe(-5000);

    finance.reversePayment(payment.id, { reason: 'unit test reversal of a payment', actor: 'Test Actor' });
    const afterReverse = { ap: accountNet('Accounts payable'), cash: accountNet('Cash/Bank') };
    expect(afterReverse.ap).toBe(before.ap);
    expect(afterReverse.cash).toBe(before.cash);

    // The original row is never edited — status stays exactly as recordPayment left it.
    expect(finance.getPayment(payment.id)!.status).toBe('CLEARED');

    expect(() => finance.reversePayment(payment.id, { reason: 'a second reversal attempt', actor: 'Test Actor' })).toThrow();
  });
});

describe('finance.reverseReceipt', () => {
  it('nets the ledger back to its pre-receipt balance without touching the original row', () => {
    const before = { income: accountNet('Other income'), cash: accountNet('Cash/Bank') };

    const receipt = finance.recordReceipt({ receivedFrom: 'Test Payer', amount: 2500, method: 'Cash' });
    const afterReceipt = { income: accountNet('Other income'), cash: accountNet('Cash/Bank') };
    expect(afterReceipt.income - before.income).toBe(-2500);
    expect(afterReceipt.cash - before.cash).toBe(2500);

    finance.reverseReceipt(receipt.id, { reason: 'unit test reversal of a receipt', actor: 'Test Actor' });
    const afterReverse = { income: accountNet('Other income'), cash: accountNet('Cash/Bank') };
    expect(afterReverse.income).toBe(before.income);
    expect(afterReverse.cash).toBe(before.cash);

    expect(finance.getReceipt(receipt.id)!.status).toBe('CLEARED');
    expect(() => finance.reverseReceipt(receipt.id, { reason: 'a second reversal attempt', actor: 'Test Actor' })).toThrow();
  });
});
