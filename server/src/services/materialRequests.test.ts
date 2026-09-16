import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, makeSupplier } from '../test/fixtures.js';
import * as materialRequests from './materialRequests.js';
import * as procurement from './procurement.js';

beforeAll(async () => { await ensureMigrated(); });

describe('materialRequests: Production requests are routed through Procurement', () => {
  it('blocks issuing a Production request that has no purchase order yet', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const request = await materialRequests.createRequest({
      requestedBy: 'Line Operator', department: 'Production', items: [{ itemId, quantity: 10 }],
    });
    await expect(materialRequests.approveAndIssue(request.id)).rejects.toThrow(/purchase order/i);
  });

  it('raisePurchaseOrder creates a linked PO, carries over quantities, and moves the request to ORDERED', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const request = await materialRequests.createRequest({
      requestedBy: 'Line Operator', department: 'Production', items: [{ itemId, quantity: 25 }],
    });

    const updated = await materialRequests.raisePurchaseOrder(request.id, {
      supplierId, requestedBy: 'Procurement Officer', items: [{ itemId, unitPrice: 40 }],
    });

    expect(updated.status).toBe('ORDERED');
    expect(updated.po_id).toBeTruthy();

    const po = await procurement.getPurchaseOrder(updated.po_id!);
    expect(po?.status).toBe('AWAITING_APPROVAL');
    const poItems = await procurement.listPurchaseOrderItems(updated.po_id!);
    expect(poItems).toHaveLength(1);
    expect(poItems[0].quantity).toBe(25);
    expect(poItems[0].unit_price).toBe(40);
  });

  it('rejects raising a purchase order without a price for every requested item', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const request = await materialRequests.createRequest({
      requestedBy: 'Line Operator', department: 'Production', items: [{ itemId, quantity: 5 }],
    });
    await expect(materialRequests.raisePurchaseOrder(request.id, { supplierId, requestedBy: 'Procurement Officer', items: [] }))
      .rejects.toThrow(/unit price/i);
  });

  it('allows issuing once a purchase order has been raised for the request', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const request = await materialRequests.createRequest({
      requestedBy: 'Line Operator', department: 'Production', items: [{ itemId, quantity: 5 }],
    });
    await materialRequests.raisePurchaseOrder(request.id, { supplierId, requestedBy: 'Procurement Officer', items: [{ itemId, unitPrice: 10 }] });

    const issued = await materialRequests.approveAndIssue(request.id);
    expect(issued.status).toBe('ISSUED');
  });

  it('cannot be rejected once it has moved past PENDING', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const request = await materialRequests.createRequest({
      requestedBy: 'Line Operator', department: 'Production', items: [{ itemId, quantity: 5 }],
    });
    await materialRequests.raisePurchaseOrder(request.id, { supplierId, requestedBy: 'Procurement Officer', items: [{ itemId, unitPrice: 10 }] });
    await expect(materialRequests.reject(request.id)).rejects.toThrow(/ORDERED/);
  });

  it('a non-Production request can still be issued straight from stock', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const request = await materialRequests.createRequest({
      requestedBy: 'Front Desk', department: 'Admin', items: [{ itemId, quantity: 2 }],
    });
    const issued = await materialRequests.approveAndIssue(request.id);
    expect(issued.status).toBe('ISSUED');
  });
});
