import { db } from '../db/client.js';
import * as activityLog from './activityLog.js';

export interface BomComponent { itemId: string; itemName: string; qtyPerUnit: number }

/** The recipe for one unit of productItemId: what gets auto-consumed (see
 *  services/production.ts recordBatch) when a batch's output is recorded. */
export async function getComponents(productItemId: string): Promise<BomComponent[]> {
  return await db.prepare(`
    SELECT bc.component_item_id AS itemId, i.name AS itemName, bc.qty_per_unit AS qtyPerUnit
    FROM bom_components bc JOIN items i ON i.id = bc.component_item_id
    WHERE bc.product_item_id = ?
    ORDER BY i.name
  `).all(productItemId) as unknown as BomComponent[];
}

/** Replaces the whole recipe for productItemId in one call — same delete-then-reinsert
 *  shape as accessControl.setAccess, for the same reason: the caller always sends the
 *  full intended set, not a diff. */
export async function setComponents(productItemId: string, components: { itemId: string; qtyPerUnit: number }[], actor: string): Promise<BomComponent[]> {
  await db.prepare('DELETE FROM bom_components WHERE product_item_id = ?').run(productItemId);
  const insert = db.prepare('INSERT INTO bom_components (product_item_id, component_item_id, qty_per_unit) VALUES (?,?,?)');
  for (const c of components) await insert.run(productItemId, c.itemId, c.qtyPerUnit);
  await activityLog.record(actor, 'updated recipe for', 'item', productItemId, `Recipe set to ${components.length} component(s)`);
  return await getComponents(productItemId);
}
