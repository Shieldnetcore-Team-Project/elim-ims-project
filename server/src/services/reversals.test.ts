import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as reversals from './reversals.js';

beforeAll(() => ensureMigrated());

describe('reversals', () => {
  it('allows the first reversal and blocks a second for the same entity', () => {
    const entityId = uniqueId('TST-ENT-');
    expect(reversals.isReversed('unit_test', entityId)).toBe(false);
    reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'initial reversal for this test' });
    expect(reversals.isReversed('unit_test', entityId)).toBe(true);
    expect(() => reversals.assertNotReversed('unit_test', entityId)).toThrow();
  });

  it('rejects a raw double-insert via the UNIQUE constraint even bypassing assertNotReversed', () => {
    const entityId = uniqueId('TST-ENT-');
    reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'first reversal for this test' });
    expect(() => reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'second reversal for this test' })).toThrow();
  });

  it('requires a reason of at least 8 characters', () => {
    const entityId = uniqueId('TST-ENT-');
    expect(() => reversals.create({ entityType: 'unit_test', entityId, reversedBy: 'Test Actor', reason: 'short' })).toThrow();
  });
});
