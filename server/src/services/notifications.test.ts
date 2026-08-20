import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as procurement from './procurement.js';
import * as sales from './sales.js';
import * as fleet from './fleet.js';
import * as payroll from './payroll.js';
import * as production from './production.js';
import * as vehicleDocuments from './vehicleDocuments.js';
import * as tillClose from './tillClose.js';
import * as notifications from './notifications.js';

beforeAll(() => ensureMigrated());

function makeVehicle(): string {
  const id = uniqueId('TST-VEH-');
  db.prepare(`INSERT INTO vehicles (id, driver, status) VALUES (?,?,'ACTIVE')`).run(id, 'Test Driver');
  return id;
}

function makeInvoiceOrder(): string {
  const itemId = makeItem({ type: 'FINISHED_GOOD' });
  const customerId = uniqueId('TST-CUS-');
  sales.createCustomer({ id: customerId, name: 'Test Delivery Customer', location: null, phone: null, customer_type: 'DISTRIBUTOR' });
  const order = sales.createOrder({ customerId, channel: 'INVOICE', rep: 'Test Rep', paymentTerms: 'ADVANCE', items: [{ itemId, quantity: 10, unitPrice: 500 }] });
  return order.id;
}

function makeEmployee(): string {
  const id = uniqueId('TST-EMP-');
  db.prepare(`INSERT INTO employees (id, name, status) VALUES (?,?,'ACTIVE')`).run(id, 'Test Employee');
  return id;
}

describe('notifications.allNotifications (Section 48 — notification center)', () => {
  it('surfaces an AWAITING_APPROVAL purchase order as a Pending Approval notification', () => {
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = makeSupplier();
    const po = procurement.createPurchaseOrder({ supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 5, unitPrice: 10 }] });

    const items = notifications.allNotifications();
    const match = items.find(n => n.category === 'PENDING_APPROVAL' && n.id === `PENDING_APPROVAL-po-${po.id}`);
    expect(match).toBeDefined();
    expect(match?.pageKey).toBe('procurement');
  });

  it('surfaces an item at or below its reorder point as a Low Stock notification', () => {
    const id = uniqueId('TST-ITEM-');
    db.prepare(`INSERT INTO items (id, name, category, type, uom, reorder_point, unit_cost) VALUES (?,?,?,?,?,?,?)`)
      .run(id, 'Low stock test item', 'Test', 'RAW_MATERIAL', 'unit', 10, 100);

    const items = notifications.allNotifications();
    const match = items.find(n => n.category === 'LOW_STOCK' && n.id === `LOW_STOCK-${id}`);
    expect(match).toBeDefined();
    expect(match?.severity).toBe('CRITICAL');
    expect(match?.pageKey).toBe('inventory');
  });

  it('surfaces an overdue asset service as a Maintenance Due notification', () => {
    const id = uniqueId('TST-ASSET-');
    db.prepare(`INSERT INTO assets (id, equipment, next_due, status) VALUES (?,?,date('now','-2 days'),'ACTIVE')`).run(id, 'Test generator');

    const items = notifications.allNotifications();
    const match = items.find(n => n.category === 'MAINTENANCE_DUE' && n.id === `MAINTENANCE_DUE-${id}`);
    expect(match).toBeDefined();
    expect(match?.severity).toBe('CRITICAL');
  });

  it('surfaces a dispatched delivery run as a Pending Delivery notification', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });

    const items = notifications.allNotifications();
    const match = items.find(n => n.category === 'PENDING_DELIVERY' && n.id === `PENDING_DELIVERY-run-${run.id}`);
    expect(match).toBeDefined();
    expect(match?.pageKey).toBe('fleet');
  });

  it('surfaces an AWAITING_APPROVAL payroll run as a Payroll Approval notification', () => {
    const empId = makeEmployee();
    const run = payroll.prepareRun({ staffId: empId, period: '2026-08', gross: 200000, preparedBy: 'Test HR' });
    payroll.reviewRun(run.id, { reviewedBy: 'Test Chairman' });

    const items = notifications.allNotifications();
    const match = items.find(n => n.category === 'PAYROLL_APPROVAL' && n.id === `PAYROLL_APPROVAL-${run.id}`);
    expect(match).toBeDefined();
    expect(match?.pageKey).toBe('payroll');
  });

  it('surfaces a completed production batch awaiting QC as a Quality Test Pending notification', () => {
    const productId = makeItem({ type: 'FINISHED_GOOD' });
    const batch = production.recordBatch({ productItemId: productId, line: 'Test Line', shift: 'Day', operator: 'Test Operator', unitsActual: 10 });

    const items = notifications.allNotifications();
    const match = items.find(n => n.category === 'QUALITY_TEST_PENDING' && n.id === `QUALITY_TEST_PENDING-batch-${batch.id}`);
    expect(match).toBeDefined();
    expect(match?.pageKey).toBe('quality-control');
  });

  it('surfaces an expired vehicle document as a Document Expiry notification', () => {
    const vehicleId = makeVehicle();
    const doc = vehicleDocuments.addDocument({ vehicleId, documentType: 'Insurance', expiryDate: '2020-01-01', actor: 'Test Officer' });

    const items = notifications.allNotifications();
    const match = items.find(n => n.category === 'DOCUMENT_EXPIRY' && n.id === `DOCUMENT_EXPIRY-${doc.id}`);
    expect(match).toBeDefined();
    expect(match?.severity).toBe('CRITICAL');
    expect(match?.pageKey).toBe('fleet');
  });

  it('reports Unclosed Till while the default till is open for today (isTillClosed itself is covered by tillClose.test.ts)', () => {
    expect(tillClose.isTillClosed()).toBe(false); // guards the premise below against run-order drift
    const items = notifications.allNotifications();
    expect(items.some(n => n.category === 'UNCLOSED_TILL')).toBe(true);
  });
});
