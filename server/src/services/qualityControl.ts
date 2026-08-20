import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as receiving from './receiving.js';
import * as production from './production.js';

export type RefType = 'GOODS_RECEIVED' | 'PRODUCTION_BATCH';
export type Verdict = 'PASS' | 'FAIL';
export type ProductType = 'RAW_WATER' | 'TREATED_WATER' | 'UNTREATED_WATER' | 'OTHER';

export interface QualityControlRecord {
  id: string; ref_type: RefType; ref_id: string; inspector: string | null;
  parameter: string | null; result: string | null; verdict: Verdict; notes: string | null;
  product_type: ProductType | null; reviewed_by: string | null; tested_at: string;
}
export interface QualityTestParameter {
  id: number; qc_id: string; parameter_name: string; measured_value: string;
  unit: string | null; min_value: number | null; max_value: number | null; expected_value: string | null; result: Verdict;
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

/** Configurable QC parameters (Section 19: "do not hard-code only pH") —
 *  read from the Settings module's "QC parameters" row, same mechanism as
 *  inventory.listCategories(). Only drives what the test-entry picker
 *  suggests; a tester can still type a parameter name that isn't on the list. */
export function parameterNames(): string[] {
  const row = db.prepare(`SELECT value FROM settings WHERE id = 'QC parameters'`).get() as { value: string } | undefined;
  const fallback = ['pH', 'Turbidity', 'Odour', 'Taste', 'Appearance/Clearness'];
  if (!row) return fallback;
  const parsed = row.value.split(',').map(s => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

/** Section 19: a real quality test — one or more named parameters, each with
 *  its own measured value and (where numeric) required range, rolled up into
 *  a single verdict. "Passed" is never an unexplained status: the overall
 *  verdict is PASS only if every parameter's own result is PASS, and
 *  whenever a parameter has both min_value and max_value and its
 *  measured_value parses as a number, the parameter's result is recomputed
 *  here from the range regardless of what the caller sent — the server is
 *  the one place "why did this pass" has to actually check out, not just be
 *  asserted by whoever typed it in. A qualitative parameter (no numeric
 *  range — Odour, Taste, Appearance) keeps the tester's own PASS/FAIL call,
 *  since there's nothing here to independently verify it against. */
export function recordTest(params: {
  refType: RefType; refId: string; inspector: string; productType?: ProductType; reviewedBy?: string;
  parameters: { name: string; measuredValue: string; unit?: string; minValue?: number; maxValue?: number; expectedValue?: string; result: Verdict }[];
  notes?: string; actor?: string;
}): QualityControlRecord {
  if (params.parameters.length === 0) throw new Error('At least one parameter is required');

  const resolved = params.parameters.map(p => {
    const numeric = Number(p.measuredValue);
    const hasRange = p.minValue != null && p.maxValue != null;
    const result: Verdict = hasRange && Number.isFinite(numeric)
      ? (numeric >= p.minValue! && numeric <= p.maxValue! ? 'PASS' : 'FAIL')
      : p.result;
    return { ...p, result };
  });
  const verdict: Verdict = resolved.every(p => p.result === 'PASS') ? 'PASS' : 'FAIL';
  const passCount = resolved.filter(p => p.result === 'PASS').length;

  const id = nextBusinessId('quality_control', 'QC-', 4);
  db.prepare(`
    INSERT INTO quality_control (id, ref_type, ref_id, inspector, parameter, result, verdict, notes, product_type, reviewed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, params.refType, params.refId, params.inspector,
    resolved.map(p => p.name).join(', '), `${passCount}/${resolved.length} parameters passed`,
    verdict, params.notes ?? null, params.productType ?? null, params.reviewedBy ?? null,
  );

  const insertParam = db.prepare(`
    INSERT INTO quality_test_parameters (qc_id, parameter_name, measured_value, unit, min_value, max_value, expected_value, result)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const p of resolved) {
    insertParam.run(id, p.name, p.measuredValue, p.unit ?? null, p.minValue ?? null, p.maxValue ?? null, p.expectedValue ?? null, p.result);
  }

  const actor = params.actor ?? params.inspector;
  if (params.refType === 'PRODUCTION_BATCH' && verdict === 'FAIL') {
    production.setStatus(params.refId, 'FAILED', actor);
  }
  activityLog.record(
    actor, 'recorded QC test for', params.refType.toLowerCase(), params.refId,
    `${id}: ${verdict} on ${params.refId} (${passCount}/${resolved.length} parameters passed — ${resolved.map(p => `${p.name}=${p.measuredValue}${p.unit ?? ''} ${p.result}`).join(', ')})`,
  );
  return getResult(id)!;
}

export function getTestParameters(qcId: string): QualityTestParameter[] {
  return db.prepare('SELECT * FROM quality_test_parameters WHERE qc_id = ?').all(qcId) as unknown as QualityTestParameter[];
}

/** Answers "why did this batch pass?" directly — the test header plus every
 *  parameter that fed its verdict. */
export function getTestDetail(qcId: string): (QualityControlRecord & { parameters: QualityTestParameter[] }) | undefined {
  const record = getResult(qcId);
  if (!record) return undefined;
  return { ...record, parameters: getTestParameters(qcId) };
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
