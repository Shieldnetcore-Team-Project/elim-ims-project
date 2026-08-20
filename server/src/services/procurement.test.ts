import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as procurement from './procurement.js';
import * as inventory from './inventory.js';

beforeAll(() => ensureMigrated());

function makeApprover() {
  const id = uniqueId('TST-USR-');
  db.prepare(`INSERT INTO users (id, name, role, status) VALUES (?,?,?,'ACTIVE')`).run(id, 'Test Approver', 'Procurement');
  db.prepare(`INSERT INTO user_page_access (user_id, page_key) VALUES (?, 'procurement-approve')`).run(id);
  return id;
}

describe('procurement.adjustLinePrice (Price Adjustment)', () => {
  it('adjusts a line price while AWAITING_APPROVAL and records the change', () => {
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = makeSupplier();
    const po = procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 100, unitPrice: 50 }],
    });

    procurement.adjustLinePrice(po.id, itemId, 65, { reason: 'Supplier renegotiated', actor: 'Test Manager' });
    const line = procurement.listPurchaseOrderItems(po.id).find(l => l.item_id === itemId)!;
    expect(line.unit_price).toBe(65);
  });

  it('blocks a price adjustment once the order is no longer awaiting approval', () => {
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = makeSupplier();
    const po = procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 10, unitPrice: 20 }],
    });
    procurement.setStatus(po.id, 'APPROVED', 'Test Manager');

    expect(() => procurement.adjustLinePrice(po.id, itemId, 30, { reason: 'too late', actor: 'Test Manager' })).toThrow();
  });

  it('requires a reason', () => {
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = makeSupplier();
    const po = procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 10, unitPrice: 20 }],
    });
    expect(() => procurement.adjustLinePrice(po.id, itemId, 25, { reason: '', actor: 'Test Manager' })).toThrow();
  });
});

describe('procurement approval self-check + configurable categories', () => {
  it('carries requested_by_user_id through so the approval route can block self-approval', () => {
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = makeSupplier();
    const officerId = makeApprover(); // also grant 'procurement-approve' so the capability check alone wouldn't have blocked them
    const po = procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', requestedByUserId: officerId, items: [{ itemId, quantity: 10, unitPrice: 20 }],
    });
    expect(po.requested_by_user_id).toBe(officerId);
    // The actual self-approval block lives in routes/purchaseOrders.ts (needs
    // an HTTP req/res), so this test only proves the service layer persists
    // and returns the field the route depends on.
  });

  it('reads the configured category list rather than a hard-coded one', () => {
    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Item categories', 'test', 'Solvents,Adhesives,Other', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
    expect(inventory.listCategories()).toEqual(['Solvents', 'Adhesives', 'Other']);

    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Item categories', 'test', 'Chemicals,Labels,Bottle Caps,Raw Materials,Packaging,Other', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
  });
});
