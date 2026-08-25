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
  unit: string;
  direction: Direction;
  quantity: number;
  unit_cost: number;
  source_type: SourceType;
  source_id: string | null;
  from_location: string | null;
  to_location: string | null;
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

export async function createItem(item: Item): Promise<void> {
  await db.prepare(
    `INSERT INTO items (id, name, category, type, uom, reorder_point, unit_cost, manufacturer_id, pieces_per_bag) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    item.id, item.name, item.category, item.type, item.uom, item.reorder_point, item.unit_cost,
    item.manufacturer_id ?? null, item.pieces_per_bag ?? null,
  );
}

export async function listItems(type?: Item['type']): Promise<Item[]> {
  if (type) return await db.prepare('SELECT * FROM items WHERE type = ? ORDER BY name').all(type) as unknown as Item[];
  return await db.prepare('SELECT * FROM items ORDER BY name').all() as unknown as Item[];
}

export async function getItem(id: string): Promise<Item | undefined> {
  return await db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined;
}

/** Configurable item categories (Procurement) — read from the Settings
 *  module's "Item categories" row rather than a fixed list, so an admin can
 *  add/remove one without a code change. items.category itself stays free
 *  text (an existing item keeps whatever category it already has even if
 *  later dropped from this list) — this only drives what the create-item
 *  picker offers. */
export async function listCategories(): Promise<string[]> {
  const row = await db.prepare(`SELECT value FROM settings WHERE id = 'Item categories'`).get() as { value: string } | undefined;
  const fallback = ['Chemicals', 'Labels', 'Bottle Caps', 'Raw Materials', 'Packaging', 'Other'];
  if (!row) return fallback;
  const parsed = row.value.split(',').map(s => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

/** The only function in the whole app allowed to write inventory_transactions.
 *  fromLocation/toLocation are the physical Source/Destination of the move (e.g.
 *  'Production Floor' -> 'Finished Goods Warehouse') — each call site states its
 *  own, the same way it already states its own note/actor, since source_type
 *  alone can't disambiguate (PRODUCTION covers both raw-material consumption
 *  and finished-goods intake). Left null for callers that don't pass one. */
export async function postTransaction(params: {
  itemId: string;
  direction: Direction;
  quantity: number;
  unitCost?: number;
  sourceType: SourceType;
  sourceId?: string;
  fromLocation?: string;
  toLocation?: string;
  note?: string;
  actor?: string;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO inventory_transactions (item_id, direction, quantity, unit_cost, source_type, source_id, from_location, to_location, note, actor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    params.itemId, params.direction, params.quantity, params.unitCost ?? 0,
    params.sourceType, params.sourceId ?? null, params.fromLocation ?? null, params.toLocation ?? null,
    params.note ?? null, params.actor ?? null,
  );
  await activityLog.record(
    params.actor ?? 'System', params.direction === 'IN' ? 'received stock for' : 'issued stock for',
    'item', params.itemId, `${params.direction} ${params.quantity} × ${params.itemId} (${params.sourceType}${params.sourceId ? ' ' + params.sourceId : ''})`,
  );
}

export async function getBalances(): Promise<InventoryBalance[]> {
  return await db.prepare(
    `SELECT i.*, COALESCE(b.on_hand, 0) AS on_hand
     FROM items i LEFT JOIN inventory_balances b ON b.item_id = i.id
     ORDER BY i.name`,
  ).all() as unknown as InventoryBalance[];
}

export async function getBalance(itemId: string): Promise<number> {
  const row = await db.prepare('SELECT on_hand FROM inventory_balances WHERE item_id = ?').get(itemId) as { on_hand: number } | undefined;
  return row?.on_hand ?? 0;
}

export async function adjustStock(itemId: string, delta: number, note: string, actor = 'System Administrator'): Promise<void> {
  await postTransaction({
    itemId, direction: delta >= 0 ? 'IN' : 'OUT', quantity: Math.abs(delta),
    sourceType: 'ADJUSTMENT', note, actor,
  });
}

export async function listTransactions(itemId?: string, limit = 300): Promise<InventoryTransaction[]> {
  const query = `
    SELECT t.id, t.item_id, i.name AS item_name, i.category, i.uom AS unit, t.direction, t.quantity, t.unit_cost,
           t.source_type, t.source_id, t.from_location, t.to_location, t.note, t.actor, t.created_at,
           SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE -t.quantity END)
             OVER (PARTITION BY t.item_id ORDER BY t.id) AS running_total
    FROM inventory_transactions t
    JOIN items i ON i.id = t.item_id
    ${itemId ? 'WHERE t.item_id = ?' : ''}
    ORDER BY t.id DESC
    LIMIT ?
  `;
  const rows = (itemId ? await db.prepare(query).all(itemId, limit) : await db.prepare(query).all(limit)) as unknown as
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
