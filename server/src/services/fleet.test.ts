import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as sales from '../services/sales.js';
import * as fleet from './fleet.js';

beforeAll(() => ensureMigrated());

function makeVehicle(): string {
  const id = uniqueId('TST-VEH-');
  db.prepare(`INSERT INTO vehicles (id, driver, status) VALUES (?,?,'ACTIVE')`).run(id, 'Test Driver');
  return id;
}

function makeUser(role: string): string {
  const id = uniqueId('TST-USR-');
  db.prepare(`INSERT INTO users (id, name, role, status) VALUES (?,?,?,'ACTIVE')`).run(id, `Test ${role}`, role);
  return id;
}

function makeInvoiceOrder(): string {
  const itemId = makeItem({ type: 'FINISHED_GOOD' });
  const customerId = uniqueId('TST-CUS-');
  sales.createCustomer({ id: customerId, name: 'Test Delivery Customer', location: null, phone: null, customer_type: 'DISTRIBUTOR' });
  const order = sales.createOrder({ customerId, channel: 'INVOICE', rep: 'Test Rep', paymentTerms: 'ADVANCE', items: [{ itemId, quantity: 10, unitPrice: 500 }] });
  return order.id;
}

describe('delivery status (Section 37)', () => {
  it('dispatch creates a run already DISPATCHED, not the old ACTIVE default', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });
    expect(run.status).toBe('DISPATCHED');
    expect(run.delivered_by).toBeNull();
  });

  it('startTransit moves DISPATCHED -> ACTIVE', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });
    const active = fleet.startTransit(run.id, 'Test Driver');
    expect(active.status).toBe('ACTIVE');
  });

  it('rejects marking delivered without a Sales manager (or System admin) authorizing it', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });
    const clerk = makeUser('Warehouse clerk');
    expect(() => fleet.markDelivered(run.id, { authorizedByUserId: clerk, deliveredBy: 'Test Driver' })).toThrow();
  });

  it('records Delivered By/At only via an authorized Sales manager, leaving the dispatch record otherwise unchanged', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });
    const manager = makeUser('Sales manager');

    const delivered = fleet.markDelivered(run.id, { authorizedByUserId: manager, deliveredBy: 'Test Driver' });
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.delivered_by).toBe('Test Driver');
    expect(delivered.delivered_at).not.toBeNull();
    // Original dispatch fields untouched.
    expect(delivered.sales_id).toBe(run.sales_id);
    expect(delivered.vehicle_id).toBe(run.vehicle_id);
    expect(delivered.route).toBe(run.route);
    expect(delivered.dispatched_at).toBe(run.dispatched_at);
    expect(sales.getOrder(salesId)?.status).toBe('DELIVERED');
  });

  it('a System admin can mark delivered even without the Sales manager role', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });
    const admin = makeUser('System admin');
    const delivered = fleet.markDelivered(run.id, { authorizedByUserId: admin, deliveredBy: 'Test Driver' });
    expect(delivered.status).toBe('DELIVERED');
  });

  it('cancelling or returning a delivery reopens the sale for redispatch', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });

    expect(fleet.pendingDispatch().some((s: any) => s.id === salesId)).toBe(false);
    fleet.cancelDelivery(run.id, { reason: 'Vehicle broke down', actor: 'Test Driver' });
    expect(sales.getOrder(salesId)?.status).toBe('PENDING');
    expect(fleet.pendingDispatch().some((s: any) => s.id === salesId)).toBe(true);

    const salesId2 = makeInvoiceOrder();
    const run2 = fleet.dispatchDelivery({ salesId: salesId2, vehicleId, driver: 'Test Driver', route: 'Idu' });
    fleet.returnDelivery(run2.id, { reason: 'Customer refused delivery', actor: 'Test Driver' });
    expect(sales.getOrder(salesId2)?.status).toBe('PENDING');
    expect(fleet.pendingDispatch().some((s: any) => s.id === salesId2)).toBe(true);
  });

  it('cannot mark delivered a run that is already delivered/cancelled/returned', () => {
    const vehicleId = makeVehicle();
    const salesId = makeInvoiceOrder();
    const run = fleet.dispatchDelivery({ salesId, vehicleId, driver: 'Test Driver', route: 'Idu' });
    fleet.cancelDelivery(run.id, { reason: 'Test', actor: 'Test Driver' });
    const manager = makeUser('Sales manager');
    expect(() => fleet.markDelivered(run.id, { authorizedByUserId: manager, deliveredBy: 'Test Driver' })).toThrow();
  });
});
