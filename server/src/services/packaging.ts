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

export function packageBatch(params: {
  batchId: string; itemId: string; quantity: number; packagedBy: string; actor?: string;
}): FinishedGoodsRecord {
  const batch = production.getBatch(params.batchId);
  if (!batch) throw new Error(`Unknown production batch ${params.batchId}`);
  if (qualityControl.latestVerdict('PRODUCTION_BATCH', params.batchId) !== 'PASS') {
    throw new Error(`Batch ${params.batchId} has not passed quality control yet`);
  }
  const id = nextBusinessId('finished_goods', 'FG-', 4);
  db.prepare('INSERT INTO finished_goods (id, batch_id, item_id, quantity, packaged_by) VALUES (?,?,?,?,?)')
    .run(id, params.batchId, params.itemId, params.quantity, params.packagedBy);
  inventory.postTransaction({
    itemId: params.itemId, direction: 'IN', quantity: params.quantity,
    sourceType: 'PRODUCTION', sourceId: params.batchId, actor: params.actor ?? params.packagedBy,
    note: `Packaged from batch ${params.batchId}`,
  });
  activityLog.record(params.actor ?? params.packagedBy, 'packaged', 'finished_goods', id, `${params.quantity} × ${params.itemId} packaged from batch ${params.batchId}`);
  return getRecord(id)!;
}

/** Module 17 reversal: undoes the inventory IN packageBatch posted (no status column
 *  exists on finished_goods to mutate — reversals.ts is the sole "is this reversed"
 *  signal, same as every other reversible entity). */
export function reverseFinishedGoods(fgId: string, params: { reason: string; actor: string }): { reversal: reversals.Reversal; record: FinishedGoodsRecord } {
  const record = getRecord(fgId);
  if (!record) throw new Error(`Unknown finished-goods record ${fgId}`);
  reversals.assertNotReversed('finished_goods', fgId);

  db.exec('BEGIN');
  try {
    inventory.postTransaction({
      itemId: record.item_id, direction: 'OUT', quantity: record.quantity,
      sourceType: 'PRODUCTION', sourceId: record.batch_id, actor: params.actor, note: `Reversal of finished-goods record ${fgId}`,
    });

    const reversal = reversals.create({
      entityType: 'finished_goods', entityId: fgId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ quantity: record.quantity }), newValue: JSON.stringify({ quantity: 0 }),
    });
    activityLog.record(
      params.actor, 'reversed', 'finished_goods', fgId,
      `Finished-goods record ${fgId} (${record.quantity} × ${record.item_id}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    db.exec('COMMIT');
    return { reversal, record: getRecord(fgId)! };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getRecord(id: string): FinishedGoodsRecord | undefined {
  return db.prepare('SELECT * FROM finished_goods WHERE id = ?').get(id) as FinishedGoodsRecord | undefined;
}

export function listFinishedGoods() {
  return db.prepare(`
    SELECT fg.*, i.name AS item_name, pb.line, pb.shift
    FROM finished_goods fg JOIN items i ON i.id = fg.item_id JOIN production_batches pb ON pb.id = fg.batch_id
    ORDER BY fg.id DESC
  `).all();
}
