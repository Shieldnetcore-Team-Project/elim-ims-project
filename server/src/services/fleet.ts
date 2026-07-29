import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as sales from './sales.js';

export interface Vehicle { id: string; driver: string | null; status: string; odometer: string | null }
export interface DeliveryRun {
  id: string; sales_id: string; vehicle_id: string; driver: string | null; route: string | null;
  status: string; dispatched_at: string; delivered_at: string | null;
}

export function listVehicles(): Vehicle[] {
  return db.prepare('SELECT * FROM vehicles ORDER BY id').all() as unknown as Vehicle[];
}
export function createVehicle(v: Vehicle): void {
  db.prepare('INSERT INTO vehicles (id, driver, status, odometer) VALUES (?,?,?,?)').run(v.id, v.driver, v.status, v.odometer);
}

export function dispatchDelivery(params: { salesId: string; vehicleId: string; driver: string; route: string; actor?: string }): DeliveryRun {
  const id = nextBusinessId('delivery_runs', 'WB-2026-', 5);
  db.prepare(`INSERT INTO delivery_runs (id, sales_id, vehicle_id, driver, route, status) VALUES (?,?,?,?,?,'ACTIVE')`)
    .run(id, params.salesId, params.vehicleId, params.driver, params.route);
  sales.setStatus(params.salesId, 'PROCESSING', params.actor ?? params.driver);
  activityLog.record(params.actor ?? params.driver, 'dispatched', 'delivery_run', id, `Delivery ${id} for ${params.salesId} via ${params.vehicleId}`);
  return getRun(id)!;
}

export function markDelivered(id: string, actor = 'System Administrator'): DeliveryRun {
  const run = getRun(id);
  if (!run) throw new Error(`Unknown delivery ${id}`);
  db.prepare(`UPDATE delivery_runs SET status = 'DELIVERED', delivered_at = datetime('now') WHERE id = ?`).run(id);
  sales.setStatus(run.sales_id, 'DELIVERED', actor);
  activityLog.record(actor, 'marked delivered', 'delivery_run', id, `Delivery ${id} completed`);
  return getRun(id)!;
}

export function getRun(id: string): DeliveryRun | undefined {
  return db.prepare('SELECT * FROM delivery_runs WHERE id = ?').get(id) as DeliveryRun | undefined;
}

export function listRuns() {
  return db.prepare(`
    SELECT dr.*, s.customer_id, c.name AS customer_name, c.location AS customer_location, v.driver AS vehicle_driver
    FROM delivery_runs dr
    JOIN sales s ON s.id = dr.sales_id
    JOIN customers c ON c.id = s.customer_id
    JOIN vehicles v ON v.id = dr.vehicle_id
    ORDER BY dr.id DESC
  `).all();
}

/** Sales orders with no delivery run yet — what Fleet & delivery shows as awaiting dispatch. */
export function pendingDispatch() {
  return db.prepare(`
    SELECT s.*, c.name AS customer_name, c.location AS customer_location FROM sales s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.channel = 'INVOICE' AND s.status IN ('PENDING','PROCESSING')
      AND s.id NOT IN (SELECT sales_id FROM delivery_runs)
    ORDER BY s.id DESC
  `).all();
}
