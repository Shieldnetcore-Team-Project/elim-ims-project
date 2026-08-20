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
export function documentTypesFor(category: 'COMMERCIAL' | 'PRIVATE'): string[] {
  const key = category === 'COMMERCIAL' ? 'Vehicle documents - Commercial' : 'Vehicle documents - Private';
  const fallback = category === 'COMMERCIAL'
    ? ['AMAC documentation', 'Local Government documentation', 'Registration', 'Insurance', 'Roadworthiness', 'Speed Limiting Device']
    : ['Registration', 'Insurance', 'Roadworthiness'];
  const row = db.prepare('SELECT value FROM settings WHERE id = ?').get(key) as { value: string } | undefined;
  const parsed = row ? row.value.split(',').map(s => s.trim()).filter(Boolean) : [];
  return parsed.length > 0 ? parsed : fallback;
}

/** Section 35: default one week before expiry, configurable via settings. */
export function notificationDays(): number {
  const row = db.prepare(`SELECT value FROM settings WHERE id = 'Document expiry notification days'`).get() as { value: string } | undefined;
  const parsed = row ? Number(row.value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function addDocument(params: {
  vehicleId: string; documentType: string; documentNumber?: string; issueDate?: string; expiryDate?: string;
  notes?: string; actor: string;
}): VehicleDocument {
  const vehicle = db.prepare('SELECT id, category FROM vehicles WHERE id = ?').get(params.vehicleId) as { id: string; category: string | null } | undefined;
  if (!vehicle) throw new Error(`Unknown vehicle ${params.vehicleId}`);
  if (vehicle.category) {
    const allowed = documentTypesFor(vehicle.category as 'COMMERCIAL' | 'PRIVATE');
    if (!allowed.includes(params.documentType)) {
      throw new Error(`${params.documentType} is not a configured document type for ${vehicle.category} vehicles`);
    }
  }
  const id = nextBusinessId('vehicle_documents', 'VDOC-', 4);
  db.prepare(`
    INSERT INTO vehicle_documents (id, vehicle_id, document_type, document_number, issue_date, expiry_date, notes, actor)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, params.vehicleId, params.documentType, params.documentNumber ?? null, params.issueDate ?? null, params.expiryDate ?? null, params.notes ?? null, params.actor);
  activityLog.record(params.actor, 'added vehicle document', 'vehicle', params.vehicleId, `${id}: ${params.documentType}`);
  return getDocument(id)!;
}

export function getDocument(id: string): VehicleDocument | undefined {
  return db.prepare('SELECT * FROM vehicle_documents WHERE id = ?').get(id) as VehicleDocument | undefined;
}

export function listDocuments(vehicleId?: string): VehicleDocument[] {
  if (vehicleId) return db.prepare('SELECT * FROM vehicle_documents WHERE vehicle_id = ? ORDER BY expiry_date').all(vehicleId) as unknown as VehicleDocument[];
  return db.prepare('SELECT * FROM vehicle_documents ORDER BY expiry_date').all() as unknown as VehicleDocument[];
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
 *  the Notification center. */
export function upcomingExpiries(windowDays?: number): ExpiryAlert[] {
  const window = windowDays ?? notificationDays();
  const rows = db.prepare(`
    SELECT vd.*, v.plate_number AS vehicle_plate_number,
      CAST(julianday(vd.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
    FROM vehicle_documents vd
    JOIN vehicles v ON v.id = vd.vehicle_id
    WHERE vd.expiry_date IS NOT NULL
      AND julianday(vd.expiry_date) - julianday('now') <= ?
    ORDER BY vd.expiry_date
  `).all(window) as unknown as (VehicleDocument & { vehicle_plate_number: string | null; days_until_expiry: number })[];
  return rows.map(r => ({ ...r, expired: r.days_until_expiry < 0 }));
}
