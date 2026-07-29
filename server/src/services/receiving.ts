import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as procurement from './procurement.js';

export interface GoodsReceived {
  id: string; po_id: string; received_by: string | null; status: string; received_at: string;
}
export interface GoodsReceivedItem { id: number; grn_id: string; item_id: string; quantity: number }

/** Records a delivery against a PO. Never touches inventory_transactions — that only
 *  happens once Quality Control approves (see services/qualityControl.ts). */
export function receiveGoods(params: {
  poId: string; receivedBy: string; items: { itemId: string; quantity: number }[]; actor?: string;
}): GoodsReceived {
  const id = nextBusinessId('goods_received', 'GRN-2026-', 5);
  db.prepare('INSERT INTO goods_received (id, po_id, received_by) VALUES (?,?,?)').run(id, params.poId, params.receivedBy);
  const insertItem = db.prepare('INSERT INTO goods_received_items (grn_id, item_id, quantity) VALUES (?,?,?)');
  for (const it of params.items) insertItem.run(id, it.itemId, it.quantity);
  procurement.setStatus(params.poId, 'RECEIVED', params.actor ?? params.receivedBy);
  activityLog.record(params.actor ?? params.receivedBy, 'recorded', 'goods_received', id, `Goods receipt ${id} against ${params.poId}, pending QC`);
  return getGoodsReceived(id)!;
}

/** The only writer of goods_received.status — Quality Control calls this on a verdict. */
export function setStatus(id: string, status: string, actor = 'System Administrator'): void {
  db.prepare('UPDATE goods_received SET status = ? WHERE id = ?').run(status, id);
  activityLog.record(actor, 'updated status of', 'goods_received', id, `Goods receipt ${id} → ${status}`);
}

export function getGoodsReceived(id: string): GoodsReceived | undefined {
  return db.prepare('SELECT * FROM goods_received WHERE id = ?').get(id) as GoodsReceived | undefined;
}

export function listItemsFor(grnId: string): GoodsReceivedItem[] {
  return db.prepare('SELECT * FROM goods_received_items WHERE grn_id = ?').all(grnId) as unknown as GoodsReceivedItem[];
}

export function listGoodsReceived() {
  return db.prepare(`
    SELECT gr.*, po.supplier_id, s.name AS supplier_name
    FROM goods_received gr
    JOIN purchase_orders po ON po.id = gr.po_id
    JOIN suppliers s ON s.id = po.supplier_id
    ORDER BY gr.id DESC
  `).all();
}

export function pendingQc() {
  return db.prepare(`
    SELECT gr.*, po.supplier_id, s.name AS supplier_name
    FROM goods_received gr
    JOIN purchase_orders po ON po.id = gr.po_id
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE gr.status = 'PENDING_QC'
    ORDER BY gr.id DESC
  `).all();
}
