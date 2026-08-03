import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';

export interface Supplier { id: string; name: string; location: string | null }
export interface PurchaseOrder {
  id: string; supplier_id: string; requested_by: string | null; status: string; created_at: string;
}
export interface PurchaseOrderItem { id: number; po_id: string; item_id: string; quantity: number; unit_price: number }

export function listSuppliers(): Supplier[] {
  return db.prepare('SELECT * FROM suppliers ORDER BY name').all() as unknown as Supplier[];
}
export function getSupplier(id: string): Supplier | undefined {
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined;
}
export function createSupplier(s: Supplier): void {
  db.prepare('INSERT INTO suppliers (id, name, location) VALUES (?,?,?)').run(s.id, s.name, s.location);
}

/** Items bought by the bag (manufacturer/grammage variants — see items.pieces_per_bag)
 *  carry a bagQuantity here instead of a trusted quantity; the piece count is always
 *  computed server-side from the item's own pieces_per_bag, never taken from the caller,
 *  so a line can't be posted with a quantity that doesn't match the bags entered. */
export function resolveQuantity(itemId: string, quantity: number, bagQuantity: number | undefined): number {
  if (bagQuantity == null) return quantity;
  const item = db.prepare('SELECT pieces_per_bag FROM items WHERE id = ?').get(itemId) as { pieces_per_bag: number | null } | undefined;
  if (!item?.pieces_per_bag) return quantity;
  return bagQuantity * item.pieces_per_bag;
}

export function createPurchaseOrder(params: {
  supplierId: string; requestedBy: string;
  items: { itemId: string; quantity: number; unitPrice: number; bagQuantity?: number }[];
  actor?: string;
}): PurchaseOrder {
  const id = nextBusinessId('purchase_orders', 'PO-2026-', 5);
  db.prepare('INSERT INTO purchase_orders (id, supplier_id, requested_by, status) VALUES (?,?,?,?)')
    .run(id, params.supplierId, params.requestedBy, 'AWAITING_APPROVAL');
  const insertItem = db.prepare('INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES (?,?,?,?)');
  for (const it of params.items) insertItem.run(id, it.itemId, resolveQuantity(it.itemId, it.quantity, it.bagQuantity), it.unitPrice);
  activityLog.record(params.actor ?? params.requestedBy, 'created', 'purchase_order', id, `Purchase order ${id}, ${params.items.length} item line(s)`);
  return getPurchaseOrder(id)!;
}

/** The only writer of purchase_orders.status — other services call this rather than UPDATE-ing directly. */
export function setStatus(id: string, status: string, actor = 'System Administrator'): PurchaseOrder | null {
  const res = db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, id);
  if (res.changes === 0) return null;
  activityLog.record(actor, 'updated status of', 'purchase_order', id, `Purchase order ${id} → ${status}`);
  return getPurchaseOrder(id) ?? null;
}

export function getPurchaseOrder(id: string): PurchaseOrder | undefined {
  return db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as PurchaseOrder | undefined;
}

export function listPurchaseOrderItems(poId: string): PurchaseOrderItem[] {
  return db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId) as unknown as PurchaseOrderItem[];
}

export function listPurchaseOrders() {
  return db.prepare(`
    SELECT po.*, s.name AS supplier_name,
      (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) AS item_count,
      (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM purchase_order_items WHERE po_id = po.id) AS total_amount
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    ORDER BY po.id DESC
  `).all();
}

/** Approved POs that haven't been received yet — what Receiving should show as "awaiting receipt". */
export function awaitingReceipt() {
  return db.prepare(`
    SELECT po.*, s.name AS supplier_name FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.status = 'APPROVED'
    ORDER BY po.id DESC
  `).all();
}
