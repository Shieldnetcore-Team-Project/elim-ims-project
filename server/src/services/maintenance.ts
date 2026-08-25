import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as finance from './finance.js';
import * as assets from './assets.js';

export type MaintenanceRefType = 'ASSET' | 'VEHICLE';
export interface MaintenanceRecord {
  id: string; ref_type: MaintenanceRefType; ref_id: string; category: string; description: string | null;
  vendor: string | null; amount: number; service_date: string; invoice_reference: string | null;
  performed_by: string | null; approved_by: string | null; next_due_date: string | null; remarks: string | null;
  actor: string | null; created_at: string;
}

/** Section 31: "the system must support adding new maintenance categories" —
 *  configurable via Settings, same mechanism as every other category list
 *  built this session. */
export async function listCategories(): Promise<string[]> {
  const row = await db.prepare(`SELECT value FROM settings WHERE id = 'Maintenance categories'`).get() as { value: string } | undefined;
  const fallback = [
    'Vehicle Fuel', 'Diesel', 'Engine Oil', 'Filters', 'Tyres', 'Tyre Maintenance', 'Brake', 'Spare Parts',
    'Machine Spare Parts', 'Generator Maintenance', 'Machine Maintenance', 'Building Maintenance',
    'Photocopier Maintenance', 'Printer Maintenance', 'Utilities', 'Electricity', 'Other Maintenance',
  ];
  const parsed = row ? row.value.split(',').map(s => s.trim()).filter(Boolean) : [];
  return parsed.length > 0 ? parsed : fallback;
}

async function assertRefExists(refType: MaintenanceRefType, refId: string): Promise<void> {
  const table = refType === 'ASSET' ? 'assets' : 'vehicles';
  const row = await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(refId);
  if (!row) throw new Error(`Unknown ${refType.toLowerCase()} ${refId}`);
}

/** One row per maintenance job — individually recorded expenditure, never
 *  folded into a lump sum. Posts a real payment (services/finance.ts) so
 *  maintenance spend shows up in the ledger and in Payables/Expense
 *  reporting, not just this table. If it's against an ASSET and a next due
 *  date is given, the asset's own Last Service/Next Due sync automatically
 *  (assets.recordService). */
export async function recordExpense(params: {
  refType: MaintenanceRefType; refId: string; category: string; description?: string; vendor?: string; amount: number;
  serviceDate?: string; invoiceReference?: string; performedBy?: string; approvedBy?: string; nextDueDate?: string;
  remarks?: string; method?: string; actor: string;
}): Promise<MaintenanceRecord> {
  if (params.amount < 0) throw new Error('Amount cannot be negative');
  await assertRefExists(params.refType, params.refId);
  const serviceDate = params.serviceDate ?? new Date().toISOString().slice(0, 10);

  const id = await nextBusinessId('maintenance_records', 'MNT-', 4);
  await db.transaction(async () => {
    await db.prepare(`
      INSERT INTO maintenance_records (id, ref_type, ref_id, category, description, vendor, amount, service_date, invoice_reference, performed_by, approved_by, next_due_date, remarks, actor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, params.refType, params.refId, params.category, params.description ?? null, params.vendor ?? null, params.amount, serviceDate,
      params.invoiceReference ?? null, params.performedBy ?? null, params.approvedBy ?? null, params.nextDueDate ?? null, params.remarks ?? null, params.actor);

    if (params.amount > 0) {
      await finance.recordPayment({
        paidTo: params.vendor ?? `${params.refType} maintenance`, amount: params.amount, method: params.method ?? 'Bank transfer',
        referenceType: 'maintenance', referenceId: id, actor: params.actor,
      });
    }

    if (params.refType === 'ASSET') {
      await assets.recordService(params.refId, { serviceDate, nextDue: params.nextDueDate });
    }

    await activityLog.record(params.actor, 'recorded maintenance for', params.refType.toLowerCase(), params.refId, `${id}: ${params.category} — ₦${params.amount.toLocaleString('en-NG')}`);
  });
  return (await getRecord(id))!;
}

export async function getRecord(id: string): Promise<MaintenanceRecord | undefined> {
  return await db.prepare('SELECT * FROM maintenance_records WHERE id = ?').get(id) as MaintenanceRecord | undefined;
}

export async function listRecords(filter?: { refType?: MaintenanceRefType; refId?: string }): Promise<MaintenanceRecord[]> {
  if (filter?.refType && filter?.refId) {
    return await db.prepare('SELECT * FROM maintenance_records WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC').all(filter.refType, filter.refId) as unknown as MaintenanceRecord[];
  }
  if (filter?.refId) return await db.prepare('SELECT * FROM maintenance_records WHERE ref_id = ? ORDER BY id DESC').all(filter.refId) as unknown as MaintenanceRecord[];
  if (filter?.refType) return await db.prepare('SELECT * FROM maintenance_records WHERE ref_type = ? ORDER BY id DESC').all(filter.refType) as unknown as MaintenanceRecord[];
  return await db.prepare('SELECT * FROM maintenance_records ORDER BY id DESC').all() as unknown as MaintenanceRecord[];
}
