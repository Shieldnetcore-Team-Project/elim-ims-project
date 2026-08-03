import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as receiving from './receiving.js';
import * as production from './production.js';

export type RefType = 'GOODS_RECEIVED' | 'PRODUCTION_BATCH';
export type Verdict = 'PASS' | 'FAIL';

export interface QualityControlRecord {
  id: string; ref_type: RefType; ref_id: string; inspector: string | null;
  parameter: string | null; result: string | null; verdict: Verdict; notes: string | null; tested_at: string;
}

/** A production batch can only be packaged once this records a PASS against it.
 *
 *  GOODS_RECEIVED is accepted here too, purely as a historical/optional quality
 *  note — it no longer drives goods_received.status or posts inventory. That
 *  moved to receiving.inspectGoodsReceived(), which reconciles expected/delivered/
 *  accepted/rejected quantities (a binary pass/fail can't represent "298 of 300
 *  accepted"). Kept working rather than removed, per backward-compatibility:
 *  any existing caller of this endpoint still gets a 201, just without the old
 *  side effects, which would otherwise now double-post inventory alongside
 *  inspectGoodsReceived. */
export function recordResult(params: {
  refType: RefType; refId: string; inspector: string; parameter?: string; result?: string;
  verdict: Verdict; notes?: string; actor?: string;
}): QualityControlRecord {
  const id = nextBusinessId('quality_control', 'QC-', 4);
  db.prepare(
    `INSERT INTO quality_control (id, ref_type, ref_id, inspector, parameter, result, verdict, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, params.refType, params.refId, params.inspector, params.parameter ?? null, params.result ?? null, params.verdict, params.notes ?? null);

  const actor = params.actor ?? params.inspector;

  if (params.refType === 'PRODUCTION_BATCH' && params.verdict === 'FAIL') {
    production.setStatus(params.refId, 'FAILED', actor);
  }

  activityLog.record(actor, 'recorded QC verdict for', params.refType.toLowerCase(), params.refId, `${params.verdict} on ${params.refId}`);
  return getResult(id)!;
}

export function getResult(id: string): QualityControlRecord | undefined {
  return db.prepare('SELECT * FROM quality_control WHERE id = ?').get(id) as QualityControlRecord | undefined;
}

export function latestVerdict(refType: RefType, refId: string): Verdict | null {
  const row = db.prepare('SELECT verdict FROM quality_control WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC LIMIT 1')
    .get(refType, refId) as { verdict: Verdict } | undefined;
  return row?.verdict ?? null;
}

export function pendingGoodsReceived() {
  return receiving.pendingQc();
}

export function pendingProductionBatches() {
  return production.pendingQc();
}

export function history(limit = 200): QualityControlRecord[] {
  return db.prepare('SELECT * FROM quality_control ORDER BY id DESC LIMIT ?').all(limit) as unknown as QualityControlRecord[];
}
