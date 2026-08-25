import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as qualityControl from './qualityControl.js';
import * as production from './production.js';
import * as reversals from './reversals.js';

export interface FinishedGoodsRecord {
  id: string; batch_id: string; item_id: string; quantity: number; packaged_by: string | null; packaged_at: string;
}

export async function packageBatch(params: {
  batchId: string; itemId: string; quantity: number; packagedBy: string; actor?: string;
}): Promise<FinishedGoodsRecord> {
  const batch = await production.getBatch(params.batchId);
  if (!batch) throw new Error(`Unknown production batch ${params.batchId}`);
  if ((await qualityControl.latestVerdict('PRODUCTION_BATCH', params.batchId)) !== 'PASS') {
    throw new Error(`Batch ${params.batchId} has not passed quality control yet`);
  }
  const id = await nextBusinessId('finished_goods', 'FG-', 4);
  await db.prepare('INSERT INTO finished_goods (id, batch_id, item_id, quantity, packaged_by) VALUES (?,?,?,?,?)')
    .run(id, params.batchId, params.itemId, params.quantity, params.packagedBy);
  await inventory.postTransaction({
    itemId: params.itemId, direction: 'IN', quantity: params.quantity,
    sourceType: 'PRODUCTION', sourceId: params.batchId, actor: params.actor ?? params.packagedBy,
    fromLocation: 'Production Floor', toLocation: 'Finished Goods Warehouse',
    note: `Packaged from batch ${params.batchId}`,
  });
  await activityLog.record(params.actor ?? params.packagedBy, 'packaged', 'finished_goods', id, `${params.quantity} × ${params.itemId} packaged from batch ${params.batchId}`);
  return (await getRecord(id))!;
}

/** Module 17 reversal: undoes the inventory IN packageBatch posted (no status column
 *  exists on finished_goods to mutate — reversals.ts is the sole "is this reversed"
 *  signal, same as every other reversible entity). */
export async function reverseFinishedGoods(fgId: string, params: { reason: string; actor: string }): Promise<{ reversal: reversals.Reversal; record: FinishedGoodsRecord }> {
  const record = await getRecord(fgId);
  if (!record) throw new Error(`Unknown finished-goods record ${fgId}`);
  await reversals.assertNotReversed('finished_goods', fgId);

  return await db.transaction(async () => {
    await inventory.postTransaction({
      itemId: record.item_id, direction: 'OUT', quantity: record.quantity,
      sourceType: 'PRODUCTION', sourceId: record.batch_id, actor: params.actor,
      fromLocation: 'Finished Goods Warehouse', toLocation: 'Production Floor',
      note: `Reversal of finished-goods record ${fgId}`,
    });

    const reversal = await reversals.create({
      entityType: 'finished_goods', entityId: fgId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ quantity: record.quantity }), newValue: JSON.stringify({ quantity: 0 }),
    });
    await activityLog.record(
      params.actor, 'reversed', 'finished_goods', fgId,
      `Finished-goods record ${fgId} (${record.quantity} × ${record.item_id}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    return { reversal, record: (await getRecord(fgId))! };
  });
}

export async function getRecord(id: string): Promise<FinishedGoodsRecord | undefined> {
  return await db.prepare('SELECT * FROM finished_goods WHERE id = ?').get(id) as FinishedGoodsRecord | undefined;
}

export async function listFinishedGoods() {
  return await db.prepare(`
    SELECT fg.*, i.name AS item_name, pb.line, pb.shift
    FROM finished_goods fg JOIN items i ON i.id = fg.item_id JOIN production_batches pb ON pb.id = fg.batch_id
    ORDER BY fg.id DESC
  `).all();
}
