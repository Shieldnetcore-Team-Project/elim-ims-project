import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';

export interface Asset {
  id: string; equipment: string; category: string | null; serial_number: string | null; location: string | null;
  assigned_department: string | null; last_service: string | null; next_due: string | null;
  service_interval_days: number | null; notes: string | null; status: string; created_at: string;
}

/** Section 30: configurable categories (Vehicles/Generators/Machines/
 *  Equipment/Building/Office Equipment/Other Fixed Assets) — same Settings
 *  mechanism as inventory.listCategories(). Company vehicles are registered
 *  in their own dedicated table (services/fleet.ts) rather than here — a
 *  "Vehicles" category asset row is only for a vehicle-adjacent fixed asset
 *  that isn't itself a registered vehicle. */
export function listCategories(): string[] {
  const row = db.prepare(`SELECT value FROM settings WHERE id = 'Asset categories'`).get() as { value: string } | undefined;
  const fallback = ['Vehicles', 'Generators', 'Machines', 'Equipment', 'Building', 'Office Equipment', 'Other Fixed Assets'];
  const parsed = row ? row.value.split(',').map(s => s.trim()).filter(Boolean) : [];
  return parsed.length > 0 ? parsed : fallback;
}

export function createAsset(params: {
  name: string; category?: string; serialNumber?: string; location?: string; assignedDepartment?: string;
  serviceIntervalDays?: number; notes?: string; actor: string;
}): Asset {
  const id = nextBusinessId('assets', 'AST-', 3);
  db.prepare(`
    INSERT INTO assets (id, equipment, category, serial_number, location, assigned_department, service_interval_days, notes)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, params.name, params.category ?? null, params.serialNumber ?? null, params.location ?? null, params.assignedDepartment ?? null, params.serviceIntervalDays ?? null, params.notes ?? null);
  activityLog.record(params.actor, 'registered asset', 'asset', id, `${id}: ${params.name}`);
  return getAsset(id)!;
}

export function getAsset(id: string): Asset | undefined {
  return db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Asset | undefined;
}

export function listAssets(): Asset[] {
  return db.prepare('SELECT * FROM assets ORDER BY id').all() as unknown as Asset[];
}

export function updateAsset(id: string, patch: {
  location?: string; assignedDepartment?: string; serviceIntervalDays?: number; notes?: string; status?: string;
}, actor: string): Asset {
  const existing = getAsset(id);
  if (!existing) throw new Error(`Unknown asset ${id}`);
  db.prepare('UPDATE assets SET location = ?, assigned_department = ?, service_interval_days = ?, notes = ?, status = ? WHERE id = ?').run(
    patch.location ?? existing.location, patch.assignedDepartment ?? existing.assigned_department,
    patch.serviceIntervalDays ?? existing.service_interval_days, patch.notes ?? existing.notes,
    patch.status ?? existing.status, id,
  );
  activityLog.record(actor, 'updated asset', 'asset', id, `${id} updated`);
  return getAsset(id)!;
}

/** Called by maintenance.recordExpense() whenever a maintenance job is
 *  logged against this asset — keeps Last Service/Next Due in sync with the
 *  maintenance record automatically, rather than needing the same dates
 *  entered twice. */
export function recordService(id: string, params: { serviceDate: string; nextDue?: string | null }): void {
  db.prepare('UPDATE assets SET last_service = ?, next_due = COALESCE(?, next_due) WHERE id = ?').run(params.serviceDate, params.nextDue ?? null, id);
}
