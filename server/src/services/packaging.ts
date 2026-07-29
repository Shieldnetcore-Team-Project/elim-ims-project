import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as qualityControl from './qualityControl.js';
import * as production from './production.js';

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
