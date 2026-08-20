import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as procurement from './procurement.js';
import * as receiving from './receiving.js';
import * as finance from './finance.js';

beforeAll(() => ensureMigrated());

function makeInvoice(supplierId: string, itemId: string, unitPrice: number, quantity: number): string {
  const po = procurement.createPurchaseOrder({ supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity, unitPrice }] });
  procurement.setStatus(po.id, 'APPROVED', 'Test Manager');
  const grn = receiving.receiveGoods({ poId: po.id, receivedBy: 'Test Receiver', items: [{ itemId, quantity }] });
  receiving.inspectGoodsReceived(grn.id, { inspectionOfficer: 'Test Inspector', lines: [{ itemId, acceptedQuantity: quantity, rejectedQuantity: 0 }] });
  return grn.id;
}

describe('finance.supplierInvoices (Section 21)', () => {
  it('15 invoices fully paid -> running balance reaches exactly zero, every invoice FULLY_PAID', () => {
    const supplierId = makeSupplier('Test Fifteen-Invoice Supplier');
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const grnIds: string[] = [];
    for (let i = 0; i < 15; i++) grnIds.push(makeInvoice(supplierId, itemId, 100, 10)); // 1,000 each

    finance.recordPayment({ paidTo: 'Test Fifteen-Invoice Supplier', supplierId, amount: 15000, method: 'Bank transfer' });

    const invoices = finance.supplierInvoices(supplierId);
    expect(invoices).toHaveLength(15);
    expect(invoices.every(i => i.status === 'FULLY_PAID')).toBe(true);
    expect(invoices.every(i => i.outstanding === 0)).toBe(true);
    expect(finance.supplierBalance(supplierId).outstanding).toBe(0);
  });

  it('one invoice partially paid stays outstanding while the rest are fully paid', () => {
    const supplierId = makeSupplier('Test Partial-Invoice Supplier');
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const grn1 = makeInvoice(supplierId, itemId, 100, 10); // 1,000
    const grn2 = makeInvoice(supplierId, itemId, 100, 10); // 1,000
    const grn3 = makeInvoice(supplierId, itemId, 100, 10); // 1,000

    // Pays grn1 in full, grn2 in full, and only half of grn3.
    finance.recordPayment({ paidTo: 'Test Partial-Invoice Supplier', supplierId, amount: 2500, method: 'Cash' });

    const invoices = finance.supplierInvoices(supplierId);
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
    expect(finance.supplierBalance(supplierId).outstanding).toBe(500);
  });

  it('reports per-invoice payment history with date and payment reference', () => {
    const supplierId = makeSupplier('Test History Supplier');
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const grnId = makeInvoice(supplierId, itemId, 100, 10); // 1,000

    const p1 = finance.recordPayment({ paidTo: 'Test History Supplier', supplierId, amount: 400, method: 'Cash' });
    const p2 = finance.recordPayment({ paidTo: 'Test History Supplier', supplierId, amount: 600, method: 'Bank transfer' });

    const invoice = finance.supplierInvoices(supplierId).find(i => i.id === grnId)!;
    expect(invoice.total).toBe(1000);
    expect(invoice.paid).toBe(1000);
    expect(invoice.outstanding).toBe(0);
    expect(invoice.payment_history.map(h => h.payment_id)).toEqual([p1.id, p2.id]);
    expect(invoice.payment_history[0].amount_applied).toBe(400);
    expect(invoice.payment_history[1].amount_applied).toBe(600);
    expect(invoice.payment_history.every(h => h.date)).toBe(true);
  });
});
