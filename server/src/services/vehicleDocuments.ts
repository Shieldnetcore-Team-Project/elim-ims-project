import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';

export interface VehicleDocument {
  id: string; vehicle_id: string; document_type: string; document_number: string | null;
  issue_date: string | null; expiry_date: string | null; notes: string | null; actor: string | null; created_at: string;
}

/** Section 34: "Different document requirements must depend on vehicle
 *  category... Do not show irrelevant documentation requirements for
 *  private vehicles." Two configurable settings rows, one per category. */
export async function documentTypesFor(category: 'COMMERCIAL' | 'PRIVATE'): Promise<string[]> {
  const key = category === 'COMMERCIAL' ? 'Vehicle documents - Commercial' : 'Vehicle documents - Private';
  const fallback = category === 'COMMERCIAL'
    ? ['AMAC documentation', 'Local Government documentation', 'Registration', 'Insurance', 'Roadworthiness', 'Speed Limiting Device']
    : ['Registration', 'Insurance', 'Roadworthiness'];
  const row = await db.prepare('SELECT value FROM settings WHERE id = ?').get(key) as { value: string } | undefined;
  const parsed = row ? row.value.split(',').map(s => s.trim()).filter(Boolean) : [];
  return parsed.length > 0 ? parsed : fallback;
}

/** Section 35: default one week before expiry, configurable via settings. */
export async function notificationDays(): Promise<number> {
  const row = await db.prepare(`SELECT value FROM settings WHERE id = 'Document expiry notification days'`).get() as { value: string } | undefined;
  const parsed = row ? Number(row.value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export async function addDocument(params: {
  vehicleId: string; documentType: string; documentNumber?: string; issueDate?: string; expiryDate?: string;
  notes?: string; actor: string;
}): Promise<VehicleDocument> {
  const vehicle = await db.prepare('SELECT id, category FROM vehicles WHERE id = ?').get(params.vehicleId) as { id: string; category: string | null } | undefined;
  if (!vehicle) throw new Error(`Unknown vehicle ${params.vehicleId}`);
  if (vehicle.category) {
    const allowed = await documentTypesFor(vehicle.category as 'COMMERCIAL' | 'PRIVATE');
    if (!allowed.includes(params.documentType)) {
      throw new Error(`${params.documentType} is not a configured document type for ${vehicle.category} vehicles`);
    }
  }
  const id = await nextBusinessId('vehicle_documents', 'VDOC-', 4);
  await db.prepare(`
    INSERT INTO vehicle_documents (id, vehicle_id, document_type, document_number, issue_date, expiry_date, notes, actor)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, params.vehicleId, params.documentType, params.documentNumber ?? null, params.issueDate ?? null, params.expiryDate ?? null, params.notes ?? null, params.actor);
  await activityLog.record(params.actor, 'added vehicle document', 'vehicle', params.vehicleId, `${id}: ${params.documentType}`);
  return (await getDocument(id))!;
}

export async function getDocument(id: string): Promise<VehicleDocument | undefined> {
  return await db.prepare('SELECT * FROM vehicle_documents WHERE id = ?').get(id) as VehicleDocument | undefined;
}

export async function listDocuments(vehicleId?: string): Promise<VehicleDocument[]> {
  if (vehicleId) return await db.prepare('SELECT * FROM vehicle_documents WHERE vehicle_id = ? ORDER BY expiry_date').all(vehicleId) as unknown as VehicleDocument[];
  return await db.prepare('SELECT * FROM vehicle_documents ORDER BY expiry_date').all() as unknown as VehicleDocument[];
}

export interface ExpiryAlert extends VehicleDocument {
  vehicle_plate_number: string | null;
  days_until_expiry: number;
  expired: boolean;
}

/** Section 35: "Every document with expiry should support notification
 *  rules... make notification interval configurable." Status is never
 *  stored — always computed live from expiry_date vs today so it can never
 *  drift stale. Surfaced identically to Dashboard, Asset/Fleet module, and
 *  the Notification center. SQLite's julianday() has no Postgres equivalent —
 *  expiry_date is a plain 'YYYY-MM-DD' TEXT column, so date - CURRENT_DATE
 *  already gives an exact integer day count. */
export async function upcomingExpiries(windowDays?: number): Promise<ExpiryAlert[]> {
  const window = windowDays ?? await notificationDays();
  const rows = await db.prepare(`
    SELECT vd.*, v.plate_number AS vehicle_plate_number,
      (vd.expiry_date::date - CURRENT_DATE) AS days_until_expiry
    FROM vehicle_documents vd
    JOIN vehicles v ON v.id = vd.vehicle_id
    WHERE vd.expiry_date IS NOT NULL
      AND (vd.expiry_date::date - CURRENT_DATE) <= ?
    ORDER BY vd.expiry_date
  `).all(window) as unknown as (VehicleDocument & { vehicle_plate_number: string | null; days_until_expiry: number })[];
  return rows.map(r => ({ ...r, expired: r.days_until_expiry < 0 }));
}
