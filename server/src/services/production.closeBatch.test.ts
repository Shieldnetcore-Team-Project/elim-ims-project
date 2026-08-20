import { describe, it, expect, beforeAll } from 'vitest';
import { makeItem, ensureMigrated } from '../test/fixtures.js';
import * as production from './production.js';
import * as packaging from './packaging.js';
import * as qualityControl from './qualityControl.js';

beforeAll(() => ensureMigrated());

function passQc(batchId: string) {
  qualityControl.recordResult({ refType: 'PRODUCTION_BATCH', refId: batchId, inspector: 'Test Inspector', verdict: 'PASS' });
}

describe('production.closeBatch (Section 24)', () => {
  it('requires packaged + rejected + wasted to exactly equal units produced', () => {
    const productId = makeItem({ type: 'FINISHED_GOOD' });
    const batch = production.recordBatch({ productItemId: productId, line: 'Line A', shift: 'Day', operator: 'Test Operator', unitsActual: 100 });
    passQc(batch.id);
    packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 90, packagedBy: 'Test Packer' });

    // 90 packaged + 5 rejected + 3 wasted = 98, not 100 -> must fail.
    expect(() => production.closeBatch(batch.id, { rejectedQuantity: 5, wastedQuantity: 3, actor: 'Test Supervisor' })).toThrow();

    const closed = production.closeBatch(batch.id, { rejectedQuantity: 6, wastedQuantity: 4, actor: 'Test Supervisor' });
    expect(closed.closed_at).toBeTruthy();
    expect(closed.closed_by).toBe('Test Supervisor');
    expect(closed.rejected_quantity).toBe(6);
    expect(closed.wasted_quantity).toBe(4);
  });

  it('cannot be closed twice', () => {
    const productId = makeItem({ type: 'FINISHED_GOOD' });
    const batch = production.recordBatch({ productItemId: productId, line: 'Line A', shift: 'Day', operator: 'Test Operator', unitsActual: 10 });
    passQc(batch.id);
    packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 10, packagedBy: 'Test Packer' });
    production.closeBatch(batch.id, { rejectedQuantity: 0, wastedQuantity: 0, actor: 'Test Supervisor' });
    expect(() => production.closeBatch(batch.id, { rejectedQuantity: 0, wastedQuantity: 0, actor: 'Test Supervisor' })).toThrow();
  });

  it('reports NOT_STARTED / PARTIAL / COMPLETE packaging status and not_yet_packaged', () => {
    const productId = makeItem({ type: 'FINISHED_GOOD' });
    const batch = production.recordBatch({ productItemId: productId, line: 'Line A', shift: 'Day', operator: 'Test Operator', unitsActual: 50 });
    passQc(batch.id);

    interface Row { id: string; packaging_status: string; not_yet_packaged: number }
    function findRow(): Row {
      return (production.listBatches() as unknown as Row[]).find(b => b.id === batch.id)!;
    }

    expect(findRow().packaging_status).toBe('NOT_STARTED');
    expect(findRow().not_yet_packaged).toBe(50);

    packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 20, packagedBy: 'Test Packer' });
    expect(findRow().packaging_status).toBe('PARTIAL');
    expect(findRow().not_yet_packaged).toBe(30);

    packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 30, packagedBy: 'Test Packer' });
    expect(findRow().packaging_status).toBe('COMPLETE');
    expect(findRow().not_yet_packaged).toBe(0);
  });
});
