import { db } from '../db/client.js';
import * as activityLog from './activityLog.js';
import * as receiving from './receiving.js';

export interface SupplierReturn {
  id: string; grn_id: string; po_id: string; supplier_id: string;
  status: string; created_by: string | null; created_at: string; completed_at: string | null;
}
export interface SupplierReturnItem { id: number; return_id: string; item_id: string; quantity: number; reason: string | null }

/** Every row here was created by receiving.inspectGoodsReceived() for a line that
 *  was rejected at inspection — the rejected quantity never touched inventory, so
 *  there's nothing to reverse here; this is a paper trail through to a supplier
 *  credit note or physical pickup. */
export async function list() {
  return await db.prepare(`
    SELECT sr.*, gr.po_id AS grn_po_id, s.name AS supplier_name
    FROM supplier_returns sr
    JOIN suppliers s ON s.id = sr.supplier_id
    JOIN goods_received gr ON gr.id = sr.grn_id
    ORDER BY sr.id DESC
  `).all();
}

export async function get(id: string): Promise<SupplierReturn | undefined> {
  return await db.prepare('SELECT * FROM supplier_returns WHERE id = ?').get(id) as SupplierReturn | undefined;
}

export async function listItemsFor(returnId: string): Promise<SupplierReturnItem[]> {
  return await db.prepare(`
    SELECT sri.*, i.name AS item_name
    FROM supplier_return_items sri JOIN items i ON i.id = sri.item_id
    WHERE sri.return_id = ?
  `).all(returnId) as unknown as SupplierReturnItem[];
}

/** A GRN has at most one supplier return (raised once, at inspection, covering
 *  every rejected line together) — completing it closes the loop on that GRN too. */
export async function markCompleted(id: string, actor = 'System Administrator'): Promise<SupplierReturn> {
  const ret = await get(id);
  if (!ret) throw new Error(`Unknown supplier return ${id}`);
  if (ret.status === 'COMPLETED') throw new Error(`${id} is already completed`);

  await db.prepare(`UPDATE supplier_returns SET status = 'COMPLETED', completed_at = now() WHERE id = ?`).run(id);
  await activityLog.record(actor, 'completed', 'supplier_return', id, `Supplier return ${id} completed`);
  await receiving.setStatus(ret.grn_id, 'RETURNED', actor);

  return (await get(id))!;
}
