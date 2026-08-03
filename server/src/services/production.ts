import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as bom from './bom.js';
import * as inventory from './inventory.js';
import * as reversals from './reversals.js';

export interface ProductionBatch {
  id: string; product_item_id: string; line: string | null; shift: string | null; operator: string | null;
  units_target: number | null; units_actual: number | null; status: string;
  water_treatment_run_id: string | null; started_at: string; completed_at: string | null;
}

/** Batches a recipe applies to auto-consume their raw materials against reported output —
 *  "PM produced 200 → that's 200 preforms, 200 caps, 200 labels" — instead of that
 *  accounting being manual. Checked in full before anything is written, so a shortfall on
 *  any one component fails the whole batch rather than leaving a partial consumption. */
export function recordBatch(params: {
  productItemId: string; line: string; shift: string; operator: string;
  unitsActual: number; unitsTarget?: number; waterTreatmentRunId?: string; actor?: string;
}): ProductionBatch {
  const actor = params.actor ?? params.operator;
  const components = bom.getComponents(params.productItemId);

  const shortfalls = components
    .map(c => ({ ...c, needed: params.unitsActual * c.qtyPerUnit, onHand: inventory.getBalance(c.itemId) }))
    .filter(c => c.onHand < c.needed);
  if (shortfalls.length > 0) {
    const detail = shortfalls.map(c => `${c.itemName} (need ${c.needed}, have ${c.onHand})`).join(', ');
    throw new Error(`Not enough raw material to cover this batch's recipe: ${detail}`);
  }

  const id = nextBusinessId('production_batches', 'PRD-', 4);
  db.prepare(
    `INSERT INTO production_batches (id, product_item_id, line, shift, operator, units_target, units_actual, status, water_treatment_run_id, completed_at)
     VALUES (?,?,?,?,?,?,?,'COMPLETED',?, datetime('now'))`,
  ).run(id, params.productItemId, params.line, params.shift, params.operator,
    params.unitsTarget ?? params.unitsActual, params.unitsActual, params.waterTreatmentRunId ?? null);

  for (const c of components) {
    inventory.postTransaction({
      itemId: c.itemId, direction: 'OUT', quantity: params.unitsActual * c.qtyPerUnit,
      sourceType: 'PRODUCTION', sourceId: id, actor,
      note: `Consumed by recipe for batch ${id} (${params.unitsActual} × ${c.itemName})`,
    });
  }

  activityLog.record(actor, 'recorded', 'production_batch', id, `Batch ${id}: ${params.unitsActual} units of ${params.productItemId}`);
  return getBatch(id)!;
}

/** The only writer of production_batches.status besides recordBatch() itself — Quality Control
 *  calls this on a FAIL verdict. */
export function setStatus(id: string, status: string, actor = 'System Administrator'): void {
  db.prepare('UPDATE production_batches SET status = ? WHERE id = ?').run(status, id);
  activityLog.record(actor, 'updated status of', 'production_batch', id, `Batch ${id} → ${status}`);
}

/** Module 17 reversal: undoes the BOM-component inventory OUT recordBatch posted —
 *  status is never mutated (see reversals.ts). Blocked if the batch's output has
 *  already been packaged (finished_goods references it) — that packaging record
 *  must be reversed first (packaging.reverseFinishedGoods), same "undo children
 *  before parents" ordering the rest of this ledger pattern implies elsewhere. */
export function reverseBatch(batchId: string, params: { reason: string; actor: string }): { reversal: reversals.Reversal; batch: ProductionBatch } {
  const batch = getBatch(batchId);
  if (!batch) throw new Error(`Unknown production batch ${batchId}`);
  reversals.assertNotReversed('production_batches', batchId);

  const packaged = (db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM finished_goods WHERE batch_id = ?').get(batchId) as { q: number }).q;
  if (packaged > 0) throw new Error(`Batch ${batchId} has already been packaged (${packaged} units) — reverse the finished-goods packaging first`);

  const components = bom.getComponents(batch.product_item_id);

  db.exec('BEGIN');
  try {
    for (const c of components) {
      inventory.postTransaction({
        itemId: c.itemId, direction: 'IN', quantity: (batch.units_actual ?? 0) * c.qtyPerUnit,
        sourceType: 'PRODUCTION', sourceId: batchId, actor: params.actor, note: `Reversal of batch ${batchId}`,
      });
    }

    const reversal = reversals.create({
      entityType: 'production_batches', entityId: batchId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ units_actual: batch.units_actual }), newValue: JSON.stringify({ units_actual: 0 }),
    });
    activityLog.record(
      params.actor, 'reversed', 'production_batch', batchId,
      `Batch ${batchId} (${batch.units_actual} units of ${batch.product_item_id}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    db.exec('COMMIT');
    return { reversal, batch: getBatch(batchId)! };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getBatch(id: string): ProductionBatch | undefined {
  return db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch | undefined;
}

export function listBatches() {
  return db.prepare(`
    SELECT pb.*, i.name AS product_name,
      (SELECT verdict FROM quality_control WHERE ref_type = 'PRODUCTION_BATCH' AND ref_id = pb.id ORDER BY id DESC LIMIT 1) AS qc_verdict,
      (SELECT COALESCE(SUM(quantity), 0) FROM finished_goods WHERE batch_id = pb.id) AS packaged_units
    FROM production_batches pb JOIN items i ON i.id = pb.product_item_id
    ORDER BY pb.id DESC
  `).all();
}

/** Completed batches with no QC verdict yet — what Quality Control shows as pending. */
export function pendingQc() {
  return db.prepare(`
    SELECT pb.*, i.name AS product_name FROM production_batches pb
    JOIN items i ON i.id = pb.product_item_id
    WHERE pb.status = 'COMPLETED'
      AND pb.id NOT IN (SELECT ref_id FROM quality_control WHERE ref_type = 'PRODUCTION_BATCH')
    ORDER BY pb.id DESC
  `).all();
}

/** QC-passed batches not yet fully packaged — what Packaging shows as available. */
export function readyToPackage() {
  return db.prepare(`
    SELECT pb.*, i.name AS product_name,
      (SELECT COALESCE(SUM(quantity), 0) FROM finished_goods WHERE batch_id = pb.id) AS packaged_units
    FROM production_batches pb
    JOIN items i ON i.id = pb.product_item_id
    WHERE pb.id IN (SELECT ref_id FROM quality_control WHERE ref_type = 'PRODUCTION_BATCH' AND verdict = 'PASS')
    ORDER BY pb.id DESC
  `).all();
}
