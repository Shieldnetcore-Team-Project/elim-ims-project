import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as sales from './sales.js';
import * as accessControl from './accessControl.js';

export interface Vehicle {
  id: string; driver: string | null; status: string; odometer: string | null;
  plate_number: string | null; vehicle_type: string | null; category: 'COMMERCIAL' | 'PRIVATE' | null; acquisition_date: string | null;
}
/** Section 37: full status vocabulary. PENDING/READY describe a sale before
 *  it has a delivery_runs row at all (see pendingDispatch below) — a run
 *  itself is only ever created already DISPATCHED, then moves forward to
 *  ACTIVE (on the road) and DELIVERED, or off to CANCELLED/RETURNED. */
export type DeliveryStatus = 'PENDING' | 'READY' | 'DISPATCHED' | 'ACTIVE' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';
// "Sales manager" owns Fleet dispatch per its role description (Module 25) —
// the same role posReceipts' reprint-approval gate uses. System admin always
// passes too, via accessControl.requireRole.
const ROLES_THAT_CAN_MARK_DELIVERED = ['Sales manager'];

export interface DeliveryRun {
  id: string; sales_id: string; vehicle_id: string; driver: string | null; route: string | null;
  status: DeliveryStatus; dispatched_at: string; delivered_by: string | null; delivered_at: string | null;
}

export function listVehicles(): Vehicle[] {
  return db.prepare('SELECT * FROM vehicles ORDER BY id').all() as unknown as Vehicle[];
}
export function getVehicle(id: string): Vehicle | undefined {
  return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as Vehicle | undefined;
}

/** Section 33: Vehicle Number is the id itself; Plate Number/Type/Category/
 *  Acquisition Date are the registration fields the spec adds on top of the
 *  original driver/status/odometer shape. */
export function createVehicle(v: {
  id: string; driver: string | null; status?: string; odometer?: string | null;
  plateNumber?: string; vehicleType?: string; category?: 'COMMERCIAL' | 'PRIVATE'; acquisitionDate?: string;
}): Vehicle {
  db.prepare('INSERT INTO vehicles (id, driver, status, odometer, plate_number, vehicle_type, category, acquisition_date) VALUES (?,?,?,?,?,?,?,?)')
    .run(v.id, v.driver, v.status ?? 'ACTIVE', v.odometer ?? null, v.plateNumber ?? null, v.vehicleType ?? null, v.category ?? null, v.acquisitionDate ?? null);
  return getVehicle(v.id)!;
}

export function dispatchDelivery(params: { salesId: string; vehicleId: string; driver: string; route: string; actor?: string }): DeliveryRun {
  const id = nextBusinessId('delivery_runs', 'WB-2026-', 5);
  db.prepare(`INSERT INTO delivery_runs (id, sales_id, vehicle_id, driver, route, status) VALUES (?,?,?,?,?,'DISPATCHED')`)
    .run(id, params.salesId, params.vehicleId, params.driver, params.route);
  sales.setStatus(params.salesId, 'PROCESSING', params.actor ?? params.driver);
  activityLog.record(params.actor ?? params.driver, 'dispatched', 'delivery_run', id, `Delivery ${id} for ${params.salesId} via ${params.vehicleId}`);
  return getRun(id)!;
}

function requireStatus(run: DeliveryRun, expected: DeliveryStatus[]): void {
  if (!expected.includes(run.status)) throw new Error(`${run.id} is ${run.status}, not ${expected.join(' or ')}`);
}

/** DISPATCHED -> ACTIVE, i.e. the driver is now actually on the road —
 *  no authorization gate; any actor involved in the dispatch can flip this. */
export function startTransit(id: string, actor: string): DeliveryRun {
  const run = getRun(id);
  if (!run) throw new Error(`Unknown delivery ${id}`);
  requireStatus(run, ['DISPATCHED']);
  db.prepare(`UPDATE delivery_runs SET status = 'ACTIVE' WHERE id = ?`).run(id);
  activityLog.record(actor, 'started transit for', 'delivery_run', id, `Delivery ${id} on the road`);
  return getRun(id)!;
}

/** The only path to DELIVERED (Section 37): "Supervisor/Admin authorized
 *  user marks Delivered." authorizedByUserId is checked server-side against
 *  the real users table (never a self-reported actor string) — the same
 *  accessControl.requireRole gate posReceipts' reprint approval and Module
 *  17's reversals use. Delivered By/At are recorded fresh here; every other
 *  field on the original dispatch record (sales_id, vehicle_id, driver,
 *  route, dispatched_at) is left completely untouched by this or any other
 *  status-transition function in this file. */
export function markDelivered(id: string, params: { authorizedByUserId: string; deliveredBy: string; actor?: string }): DeliveryRun {
  const run = getRun(id);
  if (!run) throw new Error(`Unknown delivery ${id}`);
  requireStatus(run, ['DISPATCHED', 'ACTIVE']);
  const supervisor = accessControl.requireRole(params.authorizedByUserId, ROLES_THAT_CAN_MARK_DELIVERED);
  const actor = params.actor ?? supervisor.name;
  db.prepare(`UPDATE delivery_runs SET status = 'DELIVERED', delivered_by = ?, delivered_at = datetime('now') WHERE id = ?`).run(params.deliveredBy, id);
  sales.setStatus(run.sales_id, 'DELIVERED', actor);
  activityLog.record(actor, 'marked delivered', 'delivery_run', id, `Delivery ${id} completed — delivered by ${params.deliveredBy}, authorized by ${supervisor.name}`);
  return getRun(id)!;
}

/** DISPATCHED/ACTIVE -> CANCELLED — the delivery never completed (e.g. the
 *  vehicle broke down, the order was called off). The sale drops back to
 *  PENDING so it's dispatchable again (see pendingDispatch below). */
export function cancelDelivery(id: string, params: { reason: string; actor: string }): DeliveryRun {
  const run = getRun(id);
  if (!run) throw new Error(`Unknown delivery ${id}`);
  requireStatus(run, ['DISPATCHED', 'ACTIVE']);
  if (!params.reason || !params.reason.trim()) throw new Error('A reason is required to cancel a delivery');
  db.prepare(`UPDATE delivery_runs SET status = 'CANCELLED' WHERE id = ?`).run(id);
  sales.setStatus(run.sales_id, 'PENDING', params.actor);
  activityLog.record(params.actor, 'cancelled', 'delivery_run', id, `Delivery ${id} cancelled — ${params.reason.trim()}`);
  return getRun(id)!;
}

/** DISPATCHED/ACTIVE -> RETURNED — the goods came back undelivered (customer
 *  refused, wrong address, etc.), distinct from CANCELLED (never left) and
 *  from a formal sales return/credit note (services/salesReturns.ts). The
 *  sale drops back to PENDING, same as a cancellation, so it can be
 *  redispatched or otherwise resolved. */
export function returnDelivery(id: string, params: { reason: string; actor: string }): DeliveryRun {
  const run = getRun(id);
  if (!run) throw new Error(`Unknown delivery ${id}`);
  requireStatus(run, ['DISPATCHED', 'ACTIVE']);
  if (!params.reason || !params.reason.trim()) throw new Error('A reason is required to return a delivery');
  db.prepare(`UPDATE delivery_runs SET status = 'RETURNED' WHERE id = ?`).run(id);
  sales.setStatus(run.sales_id, 'PENDING', params.actor);
  activityLog.record(params.actor, 'returned', 'delivery_run', id, `Delivery ${id} returned — ${params.reason.trim()}`);
  return getRun(id)!;
}

export function getRun(id: string): DeliveryRun | undefined {
  return db.prepare('SELECT * FROM delivery_runs WHERE id = ?').get(id) as DeliveryRun | undefined;
}

/** Section 36: "Record ... Products, Quantity, Reference" — one summary row
 *  per delivery run, with products/quantity rolled up from the underlying
 *  sales order's line items (a delivery run always maps to exactly one
 *  sales order, which may carry several line items). */
export function listRuns() {
  return db.prepare(`
    SELECT dr.*, s.customer_id, c.name AS customer_name, c.location AS customer_location, v.driver AS vehicle_driver,
      (SELECT GROUP_CONCAT(i.name || ' x' || si.quantity, ', ') FROM sales_items si JOIN items i ON i.id = si.item_id WHERE si.sales_id = s.id) AS products,
      (SELECT SUM(si.quantity) FROM sales_items si WHERE si.sales_id = s.id) AS total_quantity
    FROM delivery_runs dr
    JOIN sales s ON s.id = dr.sales_id
    JOIN customers c ON c.id = s.customer_id
    JOIN vehicles v ON v.id = dr.vehicle_id
    ORDER BY dr.id DESC
  `).all();
}

/** Sales orders awaiting dispatch — no delivery run yet, or every delivery
 *  run it's ever had ended in CANCELLED/RETURNED (so it needs a fresh one). */
export function pendingDispatch() {
  return db.prepare(`
    SELECT s.*, c.name AS customer_name, c.location AS customer_location FROM sales s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.channel = 'INVOICE' AND s.status IN ('PENDING','PROCESSING')
      AND s.id NOT IN (SELECT sales_id FROM delivery_runs WHERE status NOT IN ('CANCELLED','RETURNED'))
    ORDER BY s.id DESC
  `).all();
}
