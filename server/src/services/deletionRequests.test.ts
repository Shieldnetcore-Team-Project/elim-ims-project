import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as deletionRequests from './deletionRequests.js';
import * as finance from './finance.js';
import * as sales from './sales.js';
import * as receiving from './receiving.js';
import * as materialRequests from './materialRequests.js';

beforeAll(async () => { await ensureMigrated(); });

describe('deletionRequests posted-transaction guard (Module 17)', () => {
  it('blocks a posted payment unconditionally', async () => {
    const payment = await finance.recordPayment({ paidTo: 'Test Vendor', amount: 100, method: 'Cash' });
    await expect(deletionRequests.request({ entityType: 'payments', entityId: payment.id, requestedBy: 'Tester', reason: 'test deletion attempt' })).rejects.toThrow();
  });

  it('blocks a posted receipt unconditionally', async () => {
    const receipt = await finance.recordReceipt({ receivedFrom: 'Test Payer', amount: 100, method: 'Cash' });
    await expect(deletionRequests.request({ entityType: 'receipts', entityId: receipt.id, requestedBy: 'Tester', reason: 'test deletion attempt' })).rejects.toThrow();
  });

  it('blocks sales once posted, allows nothing to delete while AWAITING_APPROVAL other than via reject', async () => {
    const itemId = await makeItem();
    const order = await sales.createOrder({ channel: 'INVOICE', rep: 'Test Rep', items: [{ itemId, quantity: 1, unitPrice: 10 }] });
    await expect(deletionRequests.request({ entityType: 'sales', entityId: order.id, requestedBy: 'Tester', reason: 'test deletion attempt' })).rejects.toThrow();
  });

  it('allows deleting master data (items) — unaffected by the posted-transaction guard', async () => {
    const itemId = await makeItem();
    await expect(deletionRequests.request({ entityType: 'items', entityId: itemId, requestedBy: 'Tester', reason: 'test deletion of an unused item' })).resolves.not.toThrow();
  });

  it('allows a GRN while PENDING_INSPECTION, blocks it once inspected', async () => {
    const itemId = await makeItem();
    const supplierId = await makeSupplier();
    const poId = uniqueId('TST-PO-');
    await db.prepare(`INSERT INTO purchase_orders (id, supplier_id, status) VALUES (?,?, 'APPROVED')`).run(poId, supplierId);
    await db.prepare(`INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES (?,?,?,?)`).run(poId, itemId, 5, 10);

    const pendingGrn = await receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 5 }] });
    await expect(deletionRequests.request({ entityType: 'goods_received', entityId: pendingGrn.id, requestedBy: 'Tester', reason: 'test deletion pre-inspection' })).resolves.not.toThrow();

    const inspectedGrn = await receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 5 }] });
    await receiving.inspectGoodsReceived(inspectedGrn.id, { inspectionOfficer: 'Test Inspector', lines: [{ itemId, acceptedQuantity: 5, rejectedQuantity: 0 }] });
    await expect(deletionRequests.request({ entityType: 'goods_received', entityId: inspectedGrn.id, requestedBy: 'Tester', reason: 'test deletion post-inspection' })).rejects.toThrow();
  });

  it('allows a material request while PENDING, blocks it once ISSUED', async () => {
    const itemId = await makeItem();
    const pendingReq = await materialRequests.createRequest({ requestedBy: 'Tester', department: 'Production', items: [{ itemId, quantity: 2 }] });
    await expect(deletionRequests.request({ entityType: 'material_requests', entityId: pendingReq.id, requestedBy: 'Tester', reason: 'test deletion while pending' })).resolves.not.toThrow();

    const issuedReq = await materialRequests.createRequest({ requestedBy: 'Tester', department: 'Production', items: [{ itemId, quantity: 2 }] });
    await materialRequests.approveAndIssue(issuedReq.id, 'Test Actor');
    await expect(deletionRequests.request({ entityType: 'material_requests', entityId: issuedReq.id, requestedBy: 'Tester', reason: 'test deletion post-issue' })).rejects.toThrow();
  });
});
