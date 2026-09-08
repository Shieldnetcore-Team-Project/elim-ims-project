import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as reversals from './reversals.js';

beforeAll(async () => { await ensureMigrated(); });

describe('reversals', () => {
  it('allows the first reversal and blocks a second for the same entity', async () => {
    const entityId = uniqueId('TST-ENT-');
    expect(await reversals.isReversed('unit_test', entityId)).toBe(false);
    await reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'initial reversal for this test' });
    expect(await reversals.isReversed('unit_test', entityId)).toBe(true);
    await expect(reversals.assertNotReversed('unit_test', entityId)).rejects.toThrow();
  });

  it('rejects a raw double-insert via the UNIQUE constraint even bypassing assertNotReversed', async () => {
    const entityId = uniqueId('TST-ENT-');
    await reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'first reversal for this test' });
    await expect(reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'second reversal for this test' })).rejects.toThrow();
  });

  it('requires a reason of at least 8 characters', async () => {
    const entityId = uniqueId('TST-ENT-');
    await expect(reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'short' })).rejects.toThrow();
  });
});
