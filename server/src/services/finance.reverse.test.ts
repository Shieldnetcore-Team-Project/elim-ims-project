import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeSupplier } from '../test/fixtures.js';
import * as finance from './finance.js';

beforeAll(async () => { await ensureMigrated(); });

async function accountNet(account: string): Promise<number> {
  return ((await db.prepare(`SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM ledger WHERE account = ?`).get(account)) as { v: number }).v;
}

describe('finance.reversePayment', () => {
  it('nets the ledger back to its pre-payment balance without touching the original row', async () => {
    const supplierId = await makeSupplier();
    const before = { ap: await accountNet('Accounts payable'), cash: await accountNet('Cash/Bank') };

    const payment = await finance.recordPayment({ paidTo: 'Test Supplier', amount: 5000, method: 'Cash', supplierId });
    const afterPay = { ap: await accountNet('Accounts payable'), cash: await accountNet('Cash/Bank') };
    expect(afterPay.ap - before.ap).toBe(5000);
    expect(afterPay.cash - before.cash).toBe(-5000);

    await finance.reversePayment(payment.id, { reason: 'unit test reversal of a payment', actor: 'Test Actor' });
    const afterReverse = { ap: await accountNet('Accounts payable'), cash: await accountNet('Cash/Bank') };
    expect(afterReverse.ap).toBe(before.ap);
    expect(afterReverse.cash).toBe(before.cash);

    // The original row is never edited — status stays exactly as recordPayment left it.
    expect((await finance.getPayment(payment.id))!.status).toBe('CLEARED');

    await expect(finance.reversePayment(payment.id, { reason: 'a second reversal attempt', actor: 'Test Actor' })).rejects.toThrow();
  });
});

describe('finance.reverseReceipt', () => {
  it('nets the ledger back to its pre-receipt balance without touching the original row', async () => {
    const before = { income: await accountNet('Other income'), cash: await accountNet('Cash/Bank') };

    const receipt = await finance.recordReceipt({ receivedFrom: 'Test Payer', amount: 2500, method: 'Cash' });
    const afterReceipt = { income: await accountNet('Other income'), cash: await accountNet('Cash/Bank') };
    expect(afterReceipt.income - before.income).toBe(-2500);
    expect(afterReceipt.cash - before.cash).toBe(2500);

    await finance.reverseReceipt(receipt.id, { reason: 'unit test reversal of a receipt', actor: 'Test Actor' });
    const afterReverse = { income: await accountNet('Other income'), cash: await accountNet('Cash/Bank') };
    expect(afterReverse.income).toBe(before.income);
    expect(afterReverse.cash).toBe(before.cash);

    expect((await finance.getReceipt(receipt.id))!.status).toBe('CLEARED');
    await expect(finance.reverseReceipt(receipt.id, { reason: 'a second reversal attempt', actor: 'Test Actor' })).rejects.toThrow();
  });
});
