import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, uniqueId } from '../test/fixtures.js';
import * as sales from './sales.js';
import * as fleet from './fleet.js';
import * as maintenance from './maintenance.js';
import * as fuelRecords from './fuelRecords.js';
import * as driverPerformance from './driverPerformance.js';

beforeAll(async () => { await ensureMigrated(); });

async function makeVehicle(): Promise<string> {
  const id = uniqueId('TST-VEH-');
  await db.prepare(`INSERT INTO vehicles (id, driver, status) VALUES (?,?,'ACTIVE')`).run(id, 'Test Driver');
  return id;
}

async function makeInvoiceOrder(): Promise<string> {
  const itemId = await makeItem({ type: 'FINISHED_GOOD' });
  const customerId = uniqueId('TST-CUS-');
  await sales.createCustomer({ id: customerId, name: 'Test Driver Perf Customer', location: null, phone: null, customer_type: 'DISTRIBUTOR' });
  const order = await sales.createOrder({ customerId, channel: 'INVOICE', rep: 'Test Rep', paymentTerms: 'ADVANCE', items: [{ itemId, quantity: 5, unitPrice: 500 }] });
  return order.id;
}

async function makeUser(role: string): Promise<string> {
  const id = uniqueId('TST-USR-');
  await db.prepare(`INSERT INTO users (id, name, role, status) VALUES (?,?,?,'ACTIVE')`).run(id, `Test ${role}`, role);
  return id;
}

describe('driver performance (Section 38)', () => {
  it('splits Deliveries (reached the customer) from Successful Deliveries (actually delivered)', async () => {
    const vehicleId = await makeVehicle();
    const driver = uniqueId('Driver-');
    const manager = await makeUser('Sales manager');

    const run1 = await fleet.dispatchDelivery({ salesId: await makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    await fleet.markDelivered(run1.id, { authorizedByUserId: manager, deliveredBy: driver });

    const run2 = await fleet.dispatchDelivery({ salesId: await makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    await fleet.returnDelivery(run2.id, { reason: 'Customer refused', actor: driver });

    const run3 = await fleet.dispatchDelivery({ salesId: await makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    await fleet.cancelDelivery(run3.id, { reason: 'Vehicle fault', actor: driver });

    const row = (await driverPerformance.report()).find(r => r.driver === driver)!;
    expect(row.trips).toBe(3);
    expect(row.deliveries).toBe(2); // DELIVERED + RETURNED reached the customer
    expect(row.successful_deliveries).toBe(1);
    expect(row.returns).toBe(1);
    expect(row.cancelled_trips).toBe(1);
    expect(row.performance).toBeCloseTo((1 / 3) * 100, 1);
  });

  it('sums fuel and (per-vehicle) maintenance cost for the driver', async () => {
    const vehicleId = await makeVehicle();
    const driver = uniqueId('Driver-');
    await fleet.dispatchDelivery({ salesId: await makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });
    await fuelRecords.recordFuel({ vehicleId, driver, quantity: 20, unitCost: 900, actor: 'Test' });
    await maintenance.recordExpense({ refType: 'VEHICLE', refId: vehicleId, category: 'Tyres', amount: 30000, actor: 'Test' });

    const row = (await driverPerformance.report()).find(r => r.driver === driver)!;
    expect(row.fuel_cost).toBe(18000);
    expect(row.maintenance_cost).toBe(30000);
    expect(row.distance_km).toBeNull();
  });

  it('supports monthly filtering', async () => {
    const vehicleId = await makeVehicle();
    const driver = uniqueId('Driver-');
    await fleet.dispatchDelivery({ salesId: await makeInvoiceOrder(), vehicleId, driver, route: 'Idu' });

    const thisMonth = new Date().toISOString().slice(0, 7);
    const inMonth = (await driverPerformance.report(thisMonth)).find(r => r.driver === driver);
    expect(inMonth?.trips).toBe(1);

    const otherMonth = (await driverPerformance.report('2019-01')).find(r => r.driver === driver);
    expect(otherMonth).toBeUndefined();
  });
});
