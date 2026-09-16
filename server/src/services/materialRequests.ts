import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as reversals from './reversals.js';
import * as procurement from './procurement.js';

export interface MaterialRequest {
  id: string; requested_by: string | null; department: string | null; status: string;
  po_id: string | null; needed_by: string | null; created_at: string;
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

/** Procurement's response to a pending Production request: rather than issuing
 *  straight from whatever's already in stock, the request is turned into a
 *  purchase order for its items, which then runs the normal procurement
 *  lifecycle (Super Admin approval, receiving, inspection) before this request
 *  can actually be issued — see approveAndIssue below. */
export async function raisePurchaseOrder(id: string, params: {
  supplierId: string; requestedBy: string; requestedByUserId?: string;
  items: { itemId: string; unitPrice: number; bagQuantity?: number }[]; actor?: string;
}): Promise<MaterialRequest> {
  const request = await getRequest(id);
  if (!request) throw new Error(`Unknown material request ${id}`);
  if (request.status !== 'PENDING') throw new Error(`${id} is ${request.status} — only a pending request can be raised as a purchase order`);

  const requestItems = await listRequestItems(id);
  const priceFor = new Map(params.items.map(it => [it.itemId, it]));
  const missing = requestItems.find(it => !priceFor.has(it.item_id));
  if (missing) throw new Error(`No unit price supplied for ${missing.item_id}`);

  const po = await procurement.createPurchaseOrder({
    supplierId: params.supplierId, requestedBy: params.requestedBy, requestedByUserId: params.requestedByUserId,
    items: requestItems.map(it => {
      const priced = priceFor.get(it.item_id)!;
      return { itemId: it.item_id, quantity: it.quantity, unitPrice: priced.unitPrice, bagQuantity: priced.bagQuantity };
    }),
    actor: params.actor,
  });

  await db.prepare(`UPDATE material_requests SET status = 'ORDERED', po_id = ? WHERE id = ?`).run(po.id, id);
  await activityLog.record(
    params.actor ?? params.requestedBy, 'raised purchase order for', 'material_request', id,
    `Material request ${id} (${request.department}) → purchase order ${po.id}, awaiting Super Admin approval`,
  );
  return (await getRequest(id))!;
}

/** Approving and issuing are one step here — this is the only place that writes
 *  stock_movements, and the only place besides QC-approval and Sales/Packaging that
 *  is allowed to post an inventory_transactions OUT. A Production request can only
 *  reach here once it's gone through Procurement (raisePurchaseOrder set its po_id) —
 *  it isn't issued straight from stock like other departments' requests still are. */
export async function approveAndIssue(id: string, actor = 'System Administrator'): Promise<MaterialRequest> {
  const request = await getRequest(id);
  if (!request) throw new Error(`Unknown material request ${id}`);
  if (request.department === 'Production' && !request.po_id) {
    throw new Error(`${id} must be raised as a purchase order through Procurement before it can be issued`);
  }
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
  const request = await getRequest(id);
  if (!request) throw new Error(`Unknown material request ${id}`);
  if (request.status !== 'PENDING') {
    throw new Error(`${id} is ${request.status} — once a purchase order has been raised, reject it there instead`);
  }
  await db.prepare(`UPDATE material_requests SET status = 'REJECTED' WHERE id = ?`).run(id);
  await activityLog.record(actor, 'rejected', 'material_request', id, `Material request ${id} rejected`);
}

export async function listRequests() {
  return await db.prepare('SELECT * FROM material_requests ORDER BY id DESC').all();
}
