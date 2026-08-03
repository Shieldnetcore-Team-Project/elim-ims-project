import { db } from '../db/client.js';
import * as activityLog from './activityLog.js';

export type Direction = 'IN' | 'OUT';
export type SourceType = 'PURCHASE' | 'PRODUCTION' | 'SALES' | 'MATERIAL_ISSUE' | 'ADJUSTMENT';

export interface Item {
  id: string;
  name: string;
  category: string;
  type: 'RAW_MATERIAL' | 'PACKAGING' | 'CONSUMABLE' | 'FINISHED_GOOD';
  uom: string;
  reorder_point: number;
  unit_cost: number;
  manufacturer_id?: string | null;
  pieces_per_bag?: number | null;
}

export interface InventoryBalance extends Item {
  on_hand: number;
}

export interface InventoryTransaction {
  id: number;
  txn_no: string;
  item_id: string;
  item_name: string;
  category: string;
  direction: Direction;
  quantity: number;
  unit_cost: number;
  source_type: SourceType;
  source_id: string | null;
  note: string | null;
  actor: string | null;
  branch: string;
  status: string;
  created_at: string;
  qty_before: number;
  qty_after: number;
}

/** Single-site plant for now — every transaction is posted against this branch. */
const DEFAULT_BRANCH = 'Idu Central Warehouse';

export function createItem(item: Item): void {
  db.prepare(
    `INSERT INTO items (id, name, category, type, uom, reorder_point, unit_cost, manufacturer_id, pieces_per_bag) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    item.id, item.name, item.category, item.type, item.uom, item.reorder_point, item.unit_cost,
    item.manufacturer_id ?? null, item.pieces_per_bag ?? null,
  );
}

export function listItems(type?: Item['type']): Item[] {
  if (type) return db.prepare('SELECT * FROM items WHERE type = ? ORDER BY name').all(type) as unknown as Item[];
  return db.prepare('SELECT * FROM items ORDER BY name').all() as unknown as Item[];
}

export function getItem(id: string): Item | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined;
}

/** The only function in the whole app allowed to write inventory_transactions. */
export function postTransaction(params: {
  itemId: string;
  direction: Direction;
  quantity: number;
  unitCost?: number;
  sourceType: SourceType;
  sourceId?: string;
  note?: string;
  actor?: string;
}): void {
  db.prepare(
    `INSERT INTO inventory_transactions (item_id, direction, quantity, unit_cost, source_type, source_id, note, actor)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    params.itemId, params.direction, params.quantity, params.unitCost ?? 0,
    params.sourceType, params.sourceId ?? null, params.note ?? null, params.actor ?? null,
  );
  activityLog.record(
    params.actor ?? 'System', params.direction === 'IN' ? 'received stock for' : 'issued stock for',
    'item', params.itemId, `${params.direction} ${params.quantity} × ${params.itemId} (${params.sourceType}${params.sourceId ? ' ' + params.sourceId : ''})`,
  );
}

export function getBalances(): InventoryBalance[] {
  return db.prepare(
    `SELECT i.*, COALESCE(b.on_hand, 0) AS on_hand
     FROM items i LEFT JOIN inventory_balances b ON b.item_id = i.id
     ORDER BY i.name`,
  ).all() as unknown as InventoryBalance[];
}

export function getBalance(itemId: string): number {
  const row = db.prepare('SELECT on_hand FROM inventory_balances WHERE item_id = ?').get(itemId) as { on_hand: number } | undefined;
  return row?.on_hand ?? 0;
}

export function adjustStock(itemId: string, delta: number, note: string, actor = 'System Administrator'): void {
  postTransaction({
    itemId, direction: delta >= 0 ? 'IN' : 'OUT', quantity: Math.abs(delta),
    sourceType: 'ADJUSTMENT', note, actor,
  });
}

export function listTransactions(itemId?: string, limit = 300): InventoryTransaction[] {
  const query = `
    SELECT t.id, t.item_id, i.name AS item_name, i.category, t.direction, t.quantity, t.unit_cost,
           t.source_type, t.source_id, t.note, t.actor, t.created_at,
           SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE -t.quantity END)
             OVER (PARTITION BY t.item_id ORDER BY t.id) AS running_total
    FROM inventory_transactions t
    JOIN items i ON i.id = t.item_id
    ${itemId ? 'WHERE t.item_id = ?' : ''}
    ORDER BY t.id DESC
    LIMIT ?
  `;
  const rows = (itemId ? db.prepare(query).all(itemId, limit) : db.prepare(query).all(limit)) as unknown as
    (Omit<InventoryTransaction, 'txn_no' | 'branch' | 'status' | 'qty_before' | 'qty_after'> & { running_total: number })[];

  return rows.map(({ running_total, ...r }) => {
    const signed = r.direction === 'IN' ? r.quantity : -r.quantity;
    return {
      ...r,
      txn_no: `TXN-${String(r.id).padStart(6, '0')}`,
      branch: DEFAULT_BRANCH,
      status: 'COMPLETED',
      qty_after: running_total,
      qty_before: running_total - signed,
    };
  });
}
