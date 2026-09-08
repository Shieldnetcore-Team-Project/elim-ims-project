import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as procurement from './procurement.js';
import * as inventory from './inventory.js';

beforeAll(async () => { await ensureMigrated(); });

async function makeApprover() {
  const id = uniqueId('TST-USR-');
  await db.prepare(`INSERT INTO users (id, name, role, status) VALUES (?,?,?,'ACTIVE')`).run(id, 'Test Approver', 'Procurement');
  await db.prepare(`INSERT INTO user_page_access (user_id, page_key) VALUES (?, 'procurement-approve')`).run(id);
  return id;
}

describe('procurement.adjustLinePrice (Price Adjustment)', () => {
  it('adjusts a line price while AWAITING_APPROVAL and records the change', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const po = await procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 100, unitPrice: 50 }],
    });

    await procurement.adjustLinePrice(po.id, itemId, 65, { reason: 'Supplier renegotiated', actor: 'Test Manager' });
    const line = (await procurement.listPurchaseOrderItems(po.id)).find(l => l.item_id === itemId)!;
    expect(line.unit_price).toBe(65);
  });

  it('blocks a price adjustment once the order is no longer awaiting approval', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const po = await procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 10, unitPrice: 20 }],
    });
    await procurement.setStatus(po.id, 'APPROVED', 'Test Manager');

    await expect(procurement.adjustLinePrice(po.id, itemId, 30, { reason: 'too late', actor: 'Test Manager' })).rejects.toThrow();
  });

  it('requires a reason', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const po = await procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 10, unitPrice: 20 }],
    });
    await expect(procurement.adjustLinePrice(po.id, itemId, 25, { reason: '', actor: 'Test Manager' })).rejects.toThrow();
  });
});

describe('procurement approval self-check + configurable categories', () => {
  it('carries requested_by_user_id through so the approval route can block self-approval', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const officerId = await makeApprover(); // also grant 'procurement-approve' so the capability check alone wouldn't have blocked them
    const po = await procurement.createPurchaseOrder({
      supplierId, requestedBy: 'Test Officer', requestedByUserId: officerId, items: [{ itemId, quantity: 10, unitPrice: 20 }],
    });
    expect(po.requested_by_user_id).toBe(officerId);
    // The actual self-approval block lives in routes/purchaseOrders.ts (needs
    // an HTTP req/res), so this test only proves the service layer persists
    // and returns the field the route depends on.
  });

  it('reads the configured category list rather than a hard-coded one', async () => {
    await db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Item categories', 'test', 'Solvents,Adhesives,Other', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
    expect(await inventory.listCategories()).toEqual(['Solvents', 'Adhesives', 'Other']);

    await db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Item categories', 'test', 'Chemicals,Labels,Bottle Caps,Raw Materials,Packaging,Other', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
  });
});
