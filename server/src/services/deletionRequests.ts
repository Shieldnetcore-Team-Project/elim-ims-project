import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';

export interface DeletionRequest {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  requested_by: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

/** Module 17: once an entity has posted a real inventory/ledger movement, it can no
 *  longer go through this admin-approval delete flow — only a reversal (reversals.ts +
 *  each entity's own reverse* function) can correct it. Master data and pre-posting
 *  documents (a DRAFT PO, a PENDING material request, an un-inspected GRN) aren't in
 *  this map at all and keep working exactly as before. Queried directly by table
 *  rather than importing sales.ts/receiving.ts/materialRequests.ts, to avoid a
 *  circular dependency back into this file from theirs. */
const POSTED_CHECK: Record<string, (id: string) => boolean> = {
  payments: () => true,
  receipts: () => true,
  production_batches: () => true,
  finished_goods: () => true,
  sales: (id) => {
    const row = db.prepare('SELECT status FROM sales WHERE id = ?').get(id) as { status: string } | undefined;
    return row?.status !== 'AWAITING_APPROVAL';
  },
  goods_received: (id) => {
    const row = db.prepare('SELECT status FROM goods_received WHERE id = ?').get(id) as { status: string } | undefined;
    return row?.status !== 'PENDING_INSPECTION';
  },
  material_requests: (id) => {
    const row = db.prepare('SELECT status FROM material_requests WHERE id = ?').get(id) as { status: string } | undefined;
    return row?.status === 'ISSUED';
  },
};

export function request(params: { entityType: string; entityId: string; entityLabel?: string; requestedBy: string; reason: string }): DeletionRequest {
  if (POSTED_CHECK[params.entityType]?.(params.entityId)) {
    throw new Error(`${params.entityLabel ?? params.entityId} has already posted a real transaction — it cannot be deleted. Use Reverse instead.`);
  }
  const id = nextBusinessId('deletion_requests', 'DEL-', 5);
  db.prepare(
    `INSERT INTO deletion_requests (id, entity_type, entity_id, entity_label, requested_by, reason) VALUES (?,?,?,?,?,?)`,
  ).run(id, params.entityType, params.entityId, params.entityLabel ?? null, params.requestedBy, params.reason);
  activityLog.record(params.requestedBy, 'requested deletion of', params.entityType, params.entityId, `${params.entityLabel ?? params.entityId}: ${params.reason}`);
  return get(id)!;
}

export function approve(id: string, reviewedBy: string, note?: string): DeletionRequest {
  const row = get(id);
  if (!row) throw new Error(`Unknown deletion request ${id}`);
  if (row.status !== 'PENDING') throw new Error(`Deletion request ${id} has already been reviewed`);
  db.prepare(`UPDATE deletion_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`)
    .run(reviewedBy, note ?? null, id);
  activityLog.record(reviewedBy, 'approved deletion of', row.entity_type, row.entity_id, `${row.entity_label ?? row.entity_id} removed from active use`);
  return get(id)!;
}

export function reject(id: string, reviewedBy: string, note?: string): DeletionRequest {
  const row = get(id);
  if (!row) throw new Error(`Unknown deletion request ${id}`);
  if (row.status !== 'PENDING') throw new Error(`Deletion request ${id} has already been reviewed`);
  db.prepare(`UPDATE deletion_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`)
    .run(reviewedBy, note ?? null, id);
  activityLog.record(reviewedBy, 'rejected deletion request for', row.entity_type, row.entity_id, note ?? `Kept ${row.entity_label ?? row.entity_id}`);
  return get(id)!;
}

export function get(id: string): DeletionRequest | undefined {
  return db.prepare('SELECT * FROM deletion_requests WHERE id = ?').get(id) as unknown as DeletionRequest | undefined;
}

export function list(status?: 'PENDING' | 'APPROVED' | 'REJECTED'): DeletionRequest[] {
  if (status) return db.prepare('SELECT * FROM deletion_requests WHERE status = ? ORDER BY id DESC').all(status) as unknown as DeletionRequest[];
  return db.prepare('SELECT * FROM deletion_requests ORDER BY id DESC').all() as unknown as DeletionRequest[];
}

/** Applied in route handlers (not baked into every service's SQL) so an approved
 *  deletion hides a row from its own list/pickers without touching the row itself. */
// Unconstrained generic on purpose: callers pass everything from raw query-result
// shapes to typed interfaces (Payment[], ModuleRow[], ...), and every one of them has
// an `id` — but no single TS type describes both an index signature and a concrete
// interface at once, so the id lookup below casts through unknown rather than via a
// constraint that would reject one shape or the other.
export function filterDeleted<T>(entityType: string, rows: T[]): T[] {
  const deleted = new Set(
    (db.prepare(`SELECT entity_id FROM deletion_requests WHERE entity_type = ? AND status = 'APPROVED'`).all(entityType) as { entity_id: string }[])
      .map(r => r.entity_id),
  );
  return rows.filter(r => !deleted.has(String((r as unknown as { id: unknown }).id)));
}
