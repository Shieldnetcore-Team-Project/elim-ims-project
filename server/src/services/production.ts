import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';

export interface ProductionBatch {
  id: string; product_item_id: string; line: string | null; shift: string | null; operator: string | null;
  units_target: number | null; units_actual: number | null; status: string;
  water_treatment_run_id: string | null; started_at: string; completed_at: string | null;
}

export function recordBatch(params: {
  productItemId: string; line: string; shift: string; operator: string;
  unitsActual: number; unitsTarget?: number; waterTreatmentRunId?: string; actor?: string;
}): ProductionBatch {
  const id = nextBusinessId('production_batches', 'PRD-', 4);
  db.prepare(
    `INSERT INTO production_batches (id, product_item_id, line, shift, operator, units_target, units_actual, status, water_treatment_run_id, completed_at)
     VALUES (?,?,?,?,?,?,?,'COMPLETED',?, datetime('now'))`,
  ).run(id, params.productItemId, params.line, params.shift, params.operator,
    params.unitsTarget ?? params.unitsActual, params.unitsActual, params.waterTreatmentRunId ?? null);
  activityLog.record(params.actor ?? params.operator, 'recorded', 'production_batch', id, `Batch ${id}: ${params.unitsActual} units of ${params.productItemId}`);
  return getBatch(id)!;
}

/** The only writer of production_batches.status besides recordBatch() itself — Quality Control
 *  calls this on a FAIL verdict. */
export function setStatus(id: string, status: string, actor = 'System Administrator'): void {
  db.prepare('UPDATE production_batches SET status = ? WHERE id = ?').run(status, id);
  activityLog.record(actor, 'updated status of', 'production_batch', id, `Batch ${id} → ${status}`);
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
