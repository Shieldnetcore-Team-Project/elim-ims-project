import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as reversals from './reversals.js';

export interface MaterialRequest {
  id: string; requested_by: string | null; department: string | null; status: string;
  needed_by: string | null; created_at: string;
}
export interface MaterialRequestItem { id: number; request_id: string; item_id: string; quantity: number }

export function createRequest(params: {
  requestedBy: string; department: string; neededBy?: string;
  items: { itemId: string; quantity: number }[]; actor?: string;
}): MaterialRequest {
  const id = nextBusinessId('material_requests', 'MR-', 4);
  db.prepare('INSERT INTO material_requests (id, requested_by, department, needed_by) VALUES (?,?,?,?)')
    .run(id, params.requestedBy, params.department, params.neededBy ?? null);
  const insertItem = db.prepare('INSERT INTO material_request_items (request_id, item_id, quantity) VALUES (?,?,?)');
  for (const it of params.items) insertItem.run(id, it.itemId, it.quantity);
  activityLog.record(params.actor ?? params.requestedBy, 'requested', 'material_request', id, `Material request ${id} from ${params.department}`);
  return getRequest(id)!;
}

export function getRequest(id: string): MaterialRequest | undefined {
  return db.prepare('SELECT * FROM material_requests WHERE id = ?').get(id) as MaterialRequest | undefined;
}

export function listRequestItems(requestId: string): MaterialRequestItem[] {
  return db.prepare('SELECT * FROM material_request_items WHERE request_id = ?').all(requestId) as unknown as MaterialRequestItem[];
}

/** Approving and issuing are one step here — this is the only place that writes
 *  stock_movements, and the only place besides QC-approval and Sales/Packaging that
 *  is allowed to post an inventory_transactions OUT. */
export function approveAndIssue(id: string, actor = 'System Administrator'): MaterialRequest {
  const request = getRequest(id);
  if (!request) throw new Error(`Unknown material request ${id}`);
  const items = listRequestItems(id);
  const insertMovement = db.prepare(
    `INSERT INTO stock_movements (request_id, item_id, quantity, from_location, to_location, moved_by) VALUES (?,?,?,?,?,?)`,
  );
  for (const it of items) {
    insertMovement.run(id, it.item_id, it.quantity, 'Raw Material Store', request.department ?? 'Production Floor', actor);
    inventory.postTransaction({
      itemId: it.item_id, direction: 'OUT', quantity: it.quantity,
      sourceType: 'MATERIAL_ISSUE', sourceId: id, actor,
      fromLocation: 'Raw Material Store', toLocation: request.department ?? 'Production Floor',
      note: `Issued against material request ${id}`,
    });
  }
  db.prepare(`UPDATE material_requests SET status = 'ISSUED' WHERE id = ?`).run(id);
  activityLog.record(actor, 'approved and issued', 'material_request', id, `Material request ${id} issued to ${request.department}`);
  return getRequest(id)!;
}

/** Module 17 reversal: undoes the inventory OUT approveAndIssue posted — status is
 *  never mutated (see reversals.ts). Only callable once actually issued. */
export function reverseIssue(id: string, params: { reason: string; actor: string }): { reversal: reversals.Reversal; request: MaterialRequest } {
  const request = getRequest(id);
  if (!request) throw new Error(`Unknown material request ${id}`);
  if (request.status !== 'ISSUED') throw new Error(`${id} hasn't been issued yet — nothing to reverse`);
  reversals.assertNotReversed('material_requests', id);

  db.exec('BEGIN');
  try {
    for (const it of listRequestItems(id)) {
      inventory.postTransaction({
        itemId: it.item_id, direction: 'IN', quantity: it.quantity,
        sourceType: 'MATERIAL_ISSUE', sourceId: id, actor: params.actor,
        fromLocation: request.department ?? 'Production Floor', toLocation: 'Raw Material Store',
        note: `Reversal of material request ${id}`,
      });
    }

    const reversal = reversals.create({
      entityType: 'material_requests', entityId: id, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ status: 'ISSUED' }), newValue: JSON.stringify({ status: 'ISSUED_REVERSED' }),
    });
    activityLog.record(
      params.actor, 'reversed', 'material_request', id,
      `Material request ${id} (issued to ${request.department}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    db.exec('COMMIT');
    return { reversal, request: getRequest(id)! };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function reject(id: string, actor = 'System Administrator'): void {
  db.prepare(`UPDATE material_requests SET status = 'REJECTED' WHERE id = ?`).run(id);
  activityLog.record(actor, 'rejected', 'material_request', id, `Material request ${id} rejected`);
}

export function listRequests() {
  return db.prepare('SELECT * FROM material_requests ORDER BY id DESC').all();
}
