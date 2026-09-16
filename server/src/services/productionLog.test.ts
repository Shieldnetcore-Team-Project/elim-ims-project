import { describe, it, expect, beforeAll } from 'vitest';
import { makeItem, ensureMigrated } from '../test/fixtures.js';
import * as productionLog from './productionLog.js';
import * as inventory from './inventory.js';
import * as reversals from './reversals.js';

beforeAll(async () => { await ensureMigrated(); });

describe('productionLog', () => {
  it('records a timestamped entry and posts every line into warehouse stock', async () => {
    const sachet = await makeItem({ type: 'FINISHED_GOOD' });
    const bottle = await makeItem({ type: 'FINISHED_GOOD' });
    const before = { sachet: await inventory.getBalance(sachet), bottle: await inventory.getBalance(bottle) };

    const entry = await productionLog.recordEntry({
      recordedBy: 'Test Operator',
      note: 'morning run',
      items: [{ itemId: sachet, quantity: 300 }, { itemId: bottle, quantity: 120 }],
    });

    expect(entry.id).toMatch(/^PL-/);
    expect(entry.recorded_at).toBeTruthy();
    expect(entry.total_quantity).toBe(420);
    expect(entry.items).toHaveLength(2);
    expect(await inventory.getBalance(sachet)).toBe(before.sachet + 300);
    expect(await inventory.getBalance(bottle)).toBe(before.bottle + 120);
  });

  it('rejects an entry with no lines or a non-positive quantity', async () => {
    const item = await makeItem({ type: 'FINISHED_GOOD' });
    await expect(productionLog.recordEntry({ recordedBy: 'X', items: [] })).rejects.toThrow();
    await expect(productionLog.recordEntry({ recordedBy: 'X', items: [{ itemId: item, quantity: 0 }] })).rejects.toThrow();
  });

  it('reverses an entry by posting offsetting OUTs, once only', async () => {
    const item = await makeItem({ type: 'FINISHED_GOOD' });
    const before = await inventory.getBalance(item);
    const entry = await productionLog.recordEntry({ recordedBy: 'Op', items: [{ itemId: item, quantity: 200 }] });
    expect(await inventory.getBalance(item)).toBe(before + 200);

    await productionLog.reverseEntry(entry.id, { reason: 'logged in error', actor: 'Warehouse Manager' });
    expect(await inventory.getBalance(item)).toBe(before);
    expect(await reversals.isReversed('production_log_entries', entry.id)).toBe(true);

    await expect(productionLog.reverseEntry(entry.id, { reason: 'again again', actor: 'Warehouse Manager' })).rejects.toThrow();
  });
});
