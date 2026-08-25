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

export async function createRequest(params: {
  requestedBy: string; department: string; neededBy?: string;
  items: { itemId: string; quantity: number }[]; actor?: string;
}): Promise<MaterialRequest> {
  const id = await nextBusinessId('material_requests', 'MR-', 4);
  await db.prepare('INSERT INTO material_requests (id, requested_by, department, needed_by) VALUES (?,?,?,?)')
    .run(id, params.requestedBy, params.department, params.neededBy ?? null);
  const insertItem = db.prepare('INSERT INTO material_request_items (request_id, item_id, quantity) VALUES (?,?,?)');
  for (const it of params.items) await insertItem.run(id, it.itemId, it.quantity);
  await activityLog.record(params.actor ?? params.requestedBy, 'requested', 'material_request', id, `Material request ${id} from ${params.department}`);
  return (await getRequest(id))!;
}

export async function getRequest(id: string): Promise<MaterialRequest | undefined> {
  return await db.prepare('SELECT * FROM material_requests WHERE id = ?').get(id) as MaterialRequest | undefined;
}

export async function listRequestItems(requestId: string): Promise<MaterialRequestItem[]> {
  return await db.prepare('SELECT * FROM material_request_items WHERE request_id = ?').all(requestId) as unknown as MaterialRequestItem[];
}

/** Approving and issuing are one step here — this is the only place that writes
 *  stock_movements, and the only place besides QC-approval and Sales/Packaging that
 *  is allowed to post an inventory_transactions OUT. */
export async function approveAndIssue(id: string, actor = 'System Administrator'): Promise<MaterialRequest> {
  const request = await getRequest(id);
  if (!request) throw new Error(`Unknown material request ${id}`);
  const items = await listRequestItems(id);
  const insertMovement = db.prepare(
    `INSERT INTO stock_movements (request_id, item_id, quantity, from_location, to_location, moved_by) VALUES (?,?,?,?,?,?)`,
  );
  for (const it of items) {
    await insertMovement.run(id, it.item_id, it.quantity, 'Raw Material Store', request.department ?? 'Production Floor', actor);
    await inventory.postTransaction({
      itemId: it.item_id, direction: 'OUT', quantity: it.quantity,
      sourceType: 'MATERIAL_ISSUE', sourceId: id, actor,
      fromLocation: 'Raw Material Store', toLocation: request.department ?? 'Production Floor',
      note: `Issued against material request ${id}`,
    });
  }
  await db.prepare(`UPDATE material_requests SET status = 'ISSUED' WHERE id = ?`).run(id);
  await activityLog.record(actor, 'approved and issued', 'material_request', id, `Material request ${id} issued to ${request.department}`);
  return (await getRequest(id))!;
}

/** Module 17 reversal: undoes the inventory OUT approveAndIssue posted — status is
 *  never mutated (see reversals.ts). Only callable once actually issued. */
export async function reverseIssue(id: string, params: { reason: string; actor: string }): Promise<{ reversal: reversals.Reversal; request: MaterialRequest }> {
  const request = await getRequest(id);
  if (!request) throw new Error(`Unknown material request ${id}`);
  if (request.status !== 'ISSUED') throw new Error(`${id} hasn't been issued yet — nothing to reverse`);
  await reversals.assertNotReversed('material_requests', id);

  return await db.transaction(async () => {
    for (const it of await listRequestItems(id)) {
      await inventory.postTransaction({
        itemId: it.item_id, direction: 'IN', quantity: it.quantity,
        sourceType: 'MATERIAL_ISSUE', sourceId: id, actor: params.actor,
        fromLocation: request.department ?? 'Production Floor', toLocation: 'Raw Material Store',
        note: `Reversal of material request ${id}`,
      });
    }

    const reversal = await reversals.create({
      entityType: 'material_requests', entityId: id, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ status: 'ISSUED' }), newValue: JSON.stringify({ status: 'ISSUED_REVERSED' }),
    });
    await activityLog.record(
      params.actor, 'reversed', 'material_request', id,
      `Material request ${id} (issued to ${request.department}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    return { reversal, request: (await getRequest(id))! };
  });
}

export async function reject(id: string, actor = 'System Administrator'): Promise<void> {
  await db.prepare(`UPDATE material_requests SET status = 'REJECTED' WHERE id = ?`).run(id);
  await activityLog.record(actor, 'rejected', 'material_request', id, `Material request ${id} rejected`);
}

export async function listRequests() {
  return await db.prepare('SELECT * FROM material_requests ORDER BY id DESC').all();
}
