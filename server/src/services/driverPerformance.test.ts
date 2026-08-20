import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as sales from './sales.js';
import * as fleet from './fleet.js';
import * as maintenance from './maintenance.js';
import * as fuelRecords from './fuelRecords.js';
import * as driverPerformance from './driverPerformance.js';

beforeAll(() => ensureMigrated());

function makeVehicle(): string {
  const id = uniqueId('TST-VEH-');
  db.prepare(`INSERT INTO vehicles (id, driver, status) VALUES (?,?,'ACTIVE')`).run(id, 'Test Driver');
  return id;
}

function makeInvoiceOrder(): string {
  const itemId = makeItem({ type: 'FINISHED_GOOD' });
  const customerId = uniqueId('TST-CUS-');
  sales.createCustomer({ id: customerId, name: 'Test Driver Perf Customer', location: null, phone: null, customer_type: 'DISTRIBUTOR' });
  const order = sales.createOrder({ customerId, channel: 'INVOICE', rep: 'Test Rep', paymentTerms: 'ADVANCE', items: [{ itemId, quantity: 5, unitPrice: 500 }] });
  return order.id;
}

function makeUser(role: string): string {
  const id = uniqueId('TST-USR-');
  db.prepare(`INSERT INTO users (id, name, role, status) VALUES (?,?,?,'ACTIVE')`).run(id, `Test ${role}`, role);
  return id;
}

describe('driver performance (Section 38)', () => {
  it('splits Deliveries (reached the customer) from Successful Deliveries (actually delivered)', () => {
    const vehicleId = makeVehicle();
    const driver = uniqueId('Driver-');
    const manager = makeUser('Sales manager');

    const run1 = fleet.dispatchDelivery({ salesId: makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    fleet.markDelivered(run1.id, { authorizedByUserId: manager, deliveredBy: driver });

    const run2 = fleet.dispatchDelivery({ salesId: makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    fleet.returnDelivery(run2.id, { reason: 'Customer refused', actor: driver });

    const run3 = fleet.dispatchDelivery({ salesId: makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    fleet.cancelDelivery(run3.id, { reason: 'Vehicle fault', actor: driver });

    const row = driverPerformance.report().find(r => r.driver === driver)!;
    expect(row.trips).toBe(3);
    expect(row.deliveries).toBe(2); // DELIVERED + RETURNED reached the customer
    expect(row.successful_deliveries).toBe(1);
    expect(row.returns).toBe(1);
    expect(row.cancelled_trips).toBe(1);
    expect(row.performance).toBeCloseTo((1 / 3) * 100, 1);
  });

  it('sums fuel and (per-vehicle) maintenance cost for the driver', () => {
    const vehicleId = makeVehicle();
    const driver = uniqueId('Driver-');
    fleet.dispatchDelivery({ salesId: makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    fuelRecords.recordFuel({ vehicleId, driver, quantity: 20, unitCost: 900, actor: 'Test' });
    maintenance.recordExpense({ refType: 'VEHICLE', refId: vehicleId, category: 'Tyres', amount: 30000, actor: 'Test' });

    const row = driverPerformance.report().find(r => r.driver === driver)!;
    expect(row.fuel_cost).toBe(18000);
    expect(row.maintenance_cost).toBe(30000);
    expect(row.distance_km).toBeNull();
  });

  it('supports monthly filtering', () => {
    const vehicleId = makeVehicle();
    const driver = uniqueId('Driver-');
    fleet.dispatchDelivery({ salesId: makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });

    const thisMonth = new Date().toISOString().slice(0, 7);
    const inMonth = driverPerformance.report(thisMonth).find(r => r.driver === driver);
    expect(inMonth?.trips).toBe(1);

    const otherMonth = driverPerformance.report('2019-01').find(r => r.driver === driver);
    expect(otherMonth).toBeUndefined();
  });
});
