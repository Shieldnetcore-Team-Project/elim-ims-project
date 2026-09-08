import { describe, it, expect, beforeAll } from 'vitest';
import { makeItem, ensureMigrated } from '../test/fixtures.js';
import * as production from './production.js';
import * as packaging from './packaging.js';
import * as qualityControl from './qualityControl.js';

beforeAll(async () => { await ensureMigrated(); });

async function passQc(batchId: string) {
  await qualityControl.recordResult({ refType: 'PRODUCTION_BATCH', refId: batchId, inspector: 'Test Inspector', verdict: 'PASS' });
}

describe('production.closeBatch (Section 24)', () => {
  it('requires packaged + rejected + wasted to exactly equal units produced', async () => {
    const productId = await makeItem({ type: 'FINISHED_GOOD' });
    const batch = await production.recordBatch({ productItemId: productId, line: 'Line A', shift: 'Day', operator: 'Test Operator', unitsActual: 100 });
    await passQc(batch.id);
    await packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 90, packagedBy: 'Test Packer' });

    // 90 packaged + 5 rejected + 3 wasted = 98, not 100 -> must fail.
    await expect(production.closeBatch(batch.id, { rejectedQuantity: 5, wastedQuantity: 3, actor: 'Test Supervisor' })).rejects.toThrow();

    const closed = await production.closeBatch(batch.id, { rejectedQuantity: 6, wastedQuantity: 4, actor: 'Test Supervisor' });
    expect(closed.closed_at).toBeTruthy();
    expect(closed.closed_by).toBe('Test Supervisor');
    expect(closed.rejected_quantity).toBe(6);
    expect(closed.wasted_quantity).toBe(4);
  });

  it('cannot be closed twice', async () => {
    const productId = await makeItem({ type: 'FINISHED_GOOD' });
    const batch = await production.recordBatch({ productItemId: productId, line: 'Line A', shift: 'Day', operator: 'Test Operator', unitsActual: 10 });
    await passQc(batch.id);
    await packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 10, packagedBy: 'Test Packer' });
    await production.closeBatch(batch.id, { rejectedQuantity: 0, wastedQuantity: 0, actor: 'Test Supervisor' });
    await expect(production.closeBatch(batch.id, { rejectedQuantity: 0, wastedQuantity: 0, actor: 'Test Supervisor' })).rejects.toThrow();
  });

  it('reports NOT_STARTED / PARTIAL / COMPLETE packaging status and not_yet_packaged', async () => {
    const productId = await makeItem({ type: 'FINISHED_GOOD' });
    const batch = await production.recordBatch({ productItemId: productId, line: 'Line A', shift: 'Day', operator: 'Test Operator', unitsActual: 50 });
    await passQc(batch.id);

    interface Row { id: string; packaging_status: string; not_yet_packaged: number }
    async function findRow(): Promise<Row> {
      return ((await production.listBatches()) as unknown as Row[]).find(b => b.id === batch.id)!;
    }

    expect((await findRow()).packaging_status).toBe('NOT_STARTED');
    expect((await findRow()).not_yet_packaged).toBe(50);

    await packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 20, packagedBy: 'Test Packer' });
    expect((await findRow()).packaging_status).toBe('PARTIAL');
    expect((await findRow()).not_yet_packaged).toBe(30);

    await packaging.packageBatch({ batchId: batch.id, itemId: productId, quantity: 30, packagedBy: 'Test Packer' });
    expect((await findRow()).packaging_status).toBe('COMPLETE');
    expect((await findRow()).not_yet_packaged).toBe(0);
  });
});
