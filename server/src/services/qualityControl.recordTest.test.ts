import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem } from '../test/fixtures.js';
import * as production from './production.js';
import * as qualityControl from './qualityControl.js';

beforeAll(() => ensureMigrated());

function makeBatch() {
  const productId = makeItem({ type: 'FINISHED_GOOD' });
  return production.recordBatch({ productItemId: productId, line: 'Test Line', shift: 'Day', operator: 'Test Operator', unitsActual: 10 });
}

describe('qualityControl.recordTest (Section 19)', () => {
  it('passes only when every parameter passes, and explains why via the parameter breakdown', () => {
    const batch = makeBatch();
    const test = qualityControl.recordTest({
      refType: 'PRODUCTION_BATCH', refId: batch.id, inspector: 'Test Inspector', productType: 'TREATED_WATER', reviewedBy: 'Test Reviewer',
      parameters: [
        { name: 'pH', measuredValue: '7.2', unit: '', minValue: 6.5, maxValue: 8.5, result: 'PASS' },
        { name: 'Turbidity', measuredValue: '0.8', unit: 'NTU', minValue: 0, maxValue: 1, result: 'PASS' },
        { name: 'Odour', measuredValue: 'None', expectedValue: 'None', result: 'PASS' },
      ],
    });
    expect(test.verdict).toBe('PASS');
    expect(test.product_type).toBe('TREATED_WATER');
    expect(test.reviewed_by).toBe('Test Reviewer');

    const detail = qualityControl.getTestDetail(test.id)!;
    expect(detail.parameters).toHaveLength(3);
    expect(detail.parameters.every(p => p.result === 'PASS')).toBe(true);
  });

  it('fails the whole test if any single parameter fails, even if others pass', () => {
    const batch = makeBatch();
    const test = qualityControl.recordTest({
      refType: 'PRODUCTION_BATCH', refId: batch.id, inspector: 'Test Inspector',
      parameters: [
        { name: 'pH', measuredValue: '7.0', minValue: 6.5, maxValue: 8.5, result: 'PASS' },
        { name: 'Turbidity', measuredValue: '5.0', unit: 'NTU', minValue: 0, maxValue: 1, result: 'PASS' }, // client wrongly claims PASS
      ],
    });
    // Server recomputes from the range and overrides the client's claim.
    expect(test.verdict).toBe('FAIL');
    const detail = qualityControl.getTestDetail(test.id)!;
    expect(detail.parameters.find(p => p.parameter_name === 'Turbidity')!.result).toBe('FAIL');
  });

  it('never trusts a client-asserted PASS when a numeric range is given — recomputes independently', () => {
    const batch = makeBatch();
    const test = qualityControl.recordTest({
      refType: 'PRODUCTION_BATCH', refId: batch.id, inspector: 'Test Inspector',
      parameters: [{ name: 'pH', measuredValue: '9.9', minValue: 6.5, maxValue: 8.5, result: 'PASS' }],
    });
    expect(test.verdict).toBe('FAIL');
  });

  it('trusts the tester\'s call for a qualitative parameter with no numeric range', () => {
    const batch = makeBatch();
    const test = qualityControl.recordTest({
      refType: 'PRODUCTION_BATCH', refId: batch.id, inspector: 'Test Inspector',
      parameters: [{ name: 'Taste', measuredValue: 'Normal', expectedValue: 'Normal', result: 'FAIL' }],
    });
    expect(test.verdict).toBe('FAIL');
  });

  it('fails a batch on FAIL, same side effect as the legacy single-parameter recordResult', () => {
    const batch = makeBatch();
    qualityControl.recordTest({
      refType: 'PRODUCTION_BATCH', refId: batch.id, inspector: 'Test Inspector',
      parameters: [{ name: 'pH', measuredValue: '2', minValue: 6.5, maxValue: 8.5, result: 'PASS' }],
    });
    expect(production.getBatch(batch.id)!.status).toBe('FAILED');
  });

  it('reads the configured parameter list rather than a hard-coded pH-only set', () => {
    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('QC parameters', 'test', 'Chlorine,Iron,Total Hardness', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
    expect(qualityControl.parameterNames()).toEqual(['Chlorine', 'Iron', 'Total Hardness']);

    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('QC parameters', 'test', 'pH,Turbidity,Odour,Taste,Appearance/Clearness,Total Dissolved Solids,Conductivity,Chlorine Residual', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
  });
});
