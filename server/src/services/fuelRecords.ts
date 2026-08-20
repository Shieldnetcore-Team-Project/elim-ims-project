import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as finance from './finance.js';

export interface FuelRecord {
  id: string; vehicle_id: string; driver: string | null; department: string | null; fuel_date: string; fuel_type: string | null;
  quantity: number; unit_cost: number; total_cost: number; odometer: number | null; vendor: string | null;
  receipt_reference: string | null; remarks: string | null; actor: string | null; created_at: string;
}

/** Section 32: total_cost is always computed server-side (quantity ×
 *  unit_cost), never trusted from the caller. Posts a real payment so fuel
 *  spend shows up in the ledger. */
export function recordFuel(params: {
  vehicleId: string; driver?: string; department?: string; fuelDate?: string; fuelType?: string;
  quantity: number; unitCost: number; odometer?: number; vendor?: string; receiptReference?: string; remarks?: string;
  method?: string; actor: string;
}): FuelRecord {
  if (params.quantity <= 0) throw new Error('Quantity must be positive');
  if (params.unitCost < 0) throw new Error('Unit cost cannot be negative');
  const vehicle = db.prepare('SELECT id FROM vehicles WHERE id = ?').get(params.vehicleId);
  if (!vehicle) throw new Error(`Unknown vehicle ${params.vehicleId}`);

  const totalCost = params.quantity * params.unitCost;
  const fuelDate = params.fuelDate ?? new Date().toISOString().slice(0, 10);
  const id = nextBusinessId('fuel_records', 'FUEL-', 4);

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO fuel_records (id, vehicle_id, driver, department, fuel_date, fuel_type, quantity, unit_cost, total_cost, odometer, vendor, receipt_reference, remarks, actor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, params.vehicleId, params.driver ?? null, params.department ?? null, fuelDate, params.fuelType ?? null,
      params.quantity, params.unitCost, totalCost, params.odometer ?? null, params.vendor ?? null, params.receiptReference ?? null, params.remarks ?? null, params.actor);

    if (params.odometer != null) {
      db.prepare('UPDATE vehicles SET odometer = ? WHERE id = ?').run(String(params.odometer), params.vehicleId);
    }
    if (totalCost > 0) {
      finance.recordPayment({
        paidTo: params.vendor ?? 'Fuel vendor', amount: totalCost, method: params.method ?? 'Cash',
        referenceType: 'fuel', referenceId: id, actor: params.actor,
      });
    }

    activityLog.record(params.actor, 'recorded fuel for', 'vehicle', params.vehicleId, `${id}: ${params.quantity} ${params.fuelType ?? ''} — ₦${totalCost.toLocaleString('en-NG')}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getRecord(id)!;
}

export function getRecord(id: string): FuelRecord | undefined {
  return db.prepare('SELECT * FROM fuel_records WHERE id = ?').get(id) as FuelRecord | undefined;
}

export function listRecords(vehicleId?: string): FuelRecord[] {
  if (vehicleId) return db.prepare('SELECT * FROM fuel_records WHERE vehicle_id = ? ORDER BY id DESC').all(vehicleId) as unknown as FuelRecord[];
  return db.prepare('SELECT * FROM fuel_records ORDER BY id DESC').all() as unknown as FuelRecord[];
}

export type FuelGroupBy = 'vehicle' | 'driver' | 'month' | 'year' | 'department';

/** Section 32: "Provide reports by: Vehicle, Driver, Month, Year,
 *  Department" — one flexible grouping function rather than five near-
 *  identical ones. */
export function report(groupBy: FuelGroupBy): { key: string; quantity: number; total_cost: number; entries: number }[] {
  const expr: Record<FuelGroupBy, string> = {
    vehicle: 'vehicle_id',
    driver: `COALESCE(driver, 'Unspecified')`,
    month: `strftime('%Y-%m', fuel_date)`,
    year: `strftime('%Y', fuel_date)`,
    department: `COALESCE(department, 'Unspecified')`,
  };
  return db.prepare(`
    SELECT ${expr[groupBy]} AS key, SUM(quantity) AS quantity, SUM(total_cost) AS total_cost, COUNT(*) AS entries
    FROM fuel_records GROUP BY key ORDER BY key
  `).all() as unknown as { key: string; quantity: number; total_cost: number; entries: number }[];
}
