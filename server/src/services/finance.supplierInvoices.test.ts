import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, makeSupplier } from '../test/fixtures.js';
import * as procurement from './procurement.js';
import * as receiving from './receiving.js';
import * as finance from './finance.js';

beforeAll(async () => { await ensureMigrated(); });

async function makeInvoice(supplierId: string, itemId: string, unitPrice: number, quantity: number): Promise<string> {
  const po = await procurement.createPurchaseOrder({ supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity, unitPrice }] });
  await procurement.setStatus(po.id, 'APPROVED', 'Test Manager');
  const grn = await receiving.receiveGoods({ poId: po.id, receivedBy: 'Test Receiver', items: [{ itemId, quantity }] });
  await receiving.inspectGoodsReceived(grn.id, { inspectionOfficer: 'Test Inspector', lines: [{ itemId, acceptedQuantity: quantity, rejectedQuantity: 0 }] });
  return grn.id;
}

describe('finance.supplierInvoices (Section 21)', () => {
  it('15 invoices fully paid -> running balance reaches exactly zero, every invoice FULLY_PAID', async () => {
    const supplierId = await makeSupplier('Test Fifteen-Invoice Supplier');
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const grnIds: string[] = [];
    for (let i = 0; i < 15; i++) grnIds.push(await makeInvoice(supplierId, itemId, 100, 10)); // 1,000 each

    await finance.recordPayment({ paidTo: 'Test Fifteen-Invoice Supplier', supplierId, amount: 15000, method: 'Bank transfer' });

    const invoices = await finance.supplierInvoices(supplierId);
    expect(invoices).toHaveLength(15);
    expect(invoices.every(i => i.status === 'FULLY_PAID')).toBe(true);
    expect(invoices.every(i => i.outstanding === 0)).toBe(true);
    expect((await finance.supplierBalance(supplierId)).outstanding).toBe(0);
  });

  it('one invoice partially paid stays outstanding while the rest are fully paid', async () => {
    const supplierId = await makeSupplier('Test Partial-Invoice Supplier');
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const grn1 = await makeInvoice(supplierId, itemId, 100, 10); // 1,000
    const grn2 = await makeInvoice(supplierId, itemId, 100, 10); // 1,000
    const grn3 = await makeInvoice(supplierId, itemId, 100, 10); // 1,000

    // Pays grn1 in full, grn2 in full, and only half of grn3.
    await finance.recordPayment({ paidTo: 'Test Partial-Invoice Supplier', supplierId, amount: 2500, method: 'Cash' });

    const invoices = await finance.supplierInvoices(supplierId);
    const byId = new Map(invoices.map(i => [i.id, i]));
    expect(byId.get(grn1)!.status).toBe('FULLY_PAID');
    expect(byId.get(grn1)!.outstanding).toBe(0);
    expect(byId.get(grn2)!.status).toBe('FULLY_PAID');
    expect(byId.get(grn2)!.outstanding).toBe(0);
    expect(byId.get(grn3)!.status).toBe('PARTIALLY_PAID');
    expect(byId.get(grn3)!.paid).toBe(500);
    expect(byId.get(grn3)!.outstanding).toBe(500);

    // The whole point: only the partial invoice is outstanding, not "the balance" as one lump.
    expect(invoices.filter(i => i.outstanding > 0)).toHaveLength(1);
    expect((await finance.supplierBalance(supplierId)).outstanding).toBe(500);
  });

  it('reports per-invoice payment history with date and payment reference', async () => {
    const supplierId = await makeSupplier('Test History Supplier');
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const grnId = await makeInvoice(supplierId, itemId, 100, 10); // 1,000

    const p1 = await finance.recordPayment({ paidTo: 'Test History Supplier', supplierId, amount: 400, method: 'Cash' });
    const p2 = await finance.recordPayment({ paidTo: 'Test History Supplier', supplierId, amount: 600, method: 'Bank transfer' });

    const invoice = (await finance.supplierInvoices(supplierId)).find(i => i.id === grnId)!;
    expect(invoice.total).toBe(1000);
    expect(invoice.paid).toBe(1000);
    expect(invoice.outstanding).toBe(0);
    expect(invoice.payment_history.map(h => h.payment_id)).toEqual([p1.id, p2.id]);
    expect(invoice.payment_history[0].amount_applied).toBe(400);
    expect(invoice.payment_history[1].amount_applied).toBe(600);
    expect(invoice.payment_history.every(h => h.date)).toBe(true);
  });
});
