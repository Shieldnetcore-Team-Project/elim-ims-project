import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as deletionRequests from './deletionRequests.js';
import * as finance from './finance.js';
import * as sales from './sales.js';
import * as receiving from './receiving.js';
import * as materialRequests from './materialRequests.js';

beforeAll(() => ensureMigrated());

describe('deletionRequests posted-transaction guard (Module 17)', () => {
  it('blocks a posted payment unconditionally', () => {
    const payment = finance.recordPayment({ paidTo: 'Test Vendor', amount: 100, method: 'Cash' });
    expect(() => deletionRequests.request({ entityType: 'payments', entityId: payment.id, requestedBy: 'Tester', reason: 'test deletion attempt' })).toThrow();
  });

  it('blocks a posted receipt unconditionally', () => {
    const receipt = finance.recordReceipt({ receivedFrom: 'Test Payer', amount: 100, method: 'Cash' });
    expect(() => deletionRequests.request({ entityType: 'receipts', entityId: receipt.id, requestedBy: 'Tester', reason: 'test deletion attempt' })).toThrow();
  });

  it('blocks sales once posted, allows nothing to delete while AWAITING_APPROVAL other than via reject', () => {
    const itemId = makeItem();
    const order = sales.createOrder({ channel: 'INVOICE', rep: 'Test Rep', items: [{ itemId, quantity: 1, unitPrice: 10 }] });
    expect(() => deletionRequests.request({ entityType: 'sales', entityId: order.id, requestedBy: 'Tester', reason: 'test deletion attempt' })).toThrow();
  });

  it('allows deleting master data (items) — unaffected by the posted-transaction guard', () => {
    const itemId = makeItem();
    expect(() => deletionRequests.request({ entityType: 'items', entityId: itemId, requestedBy: 'Tester', reason: 'test deletion of an unused item' })).not.toThrow();
  });

  it('allows a GRN while PENDING_INSPECTION, blocks it once inspected', () => {
    const itemId = makeItem();
    const supplierId = makeSupplier();
    const poId = uniqueId('TST-PO-');
    db.prepare(`INSERT INTO purchase_orders (id, supplier_id, status) VALUES (?,?, 'APPROVED')`).run(poId, supplierId);
    db.prepare(`INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES (?,?,?,?)`).run(poId, itemId, 5, 10);

    const pendingGrn = receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 5 }] });
    expect(() => deletionRequests.request({ entityType: 'goods_received', entityId: pendingGrn.id, requestedBy: 'Tester', reason: 'test deletion pre-inspection' })).not.toThrow();

    const inspectedGrn = receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 5 }] });
    receiving.inspectGoodsReceived(inspectedGrn.id, { inspectionOfficer: 'Test Inspector', lines: [{ itemId, acceptedQuantity: 5, rejectedQuantity: 0 }] });
    expect(() => deletionRequests.request({ entityType: 'goods_received', entityId: inspectedGrn.id, requestedBy: 'Tester', reason: 'test deletion post-inspection' })).toThrow();
  });

  it('allows a material request while PENDING, blocks it once ISSUED', () => {
    const itemId = makeItem();
    const pendingReq = materialRequests.createRequest({ requestedBy: 'Tester', department: 'Production', items: [{ itemId, quantity: 2 }] });
    expect(() => deletionRequests.request({ entityType: 'material_requests', entityId: pendingReq.id, requestedBy: 'Tester', reason: 'test deletion while pending' })).not.toThrow();

    const issuedReq = materialRequests.createRequest({ requestedBy: 'Tester', department: 'Production', items: [{ itemId, quantity: 2 }] });
    materialRequests.approveAndIssue(issuedReq.id, 'Test Actor');
    expect(() => deletionRequests.request({ entityType: 'material_requests', entityId: issuedReq.id, requestedBy: 'Tester', reason: 'test deletion post-issue' })).toThrow();
  });
});
