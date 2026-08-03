import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as activityLog from './activityLog.js';

interface ActivityRow { department: string | null; old_value: string | null; new_value: string | null; reason: string | null }

function lastFor(targetId: string): ActivityRow {
  return db.prepare(`SELECT department, old_value, new_value, reason FROM activity_log WHERE target_id = ? ORDER BY id DESC LIMIT 1`).get(targetId) as unknown as ActivityRow;
}

beforeAll(() => ensureMigrated());

describe('activityLog.record (Module 17)', () => {
  it('stays backward compatible with the pre-Module-17 5-arg call shape', () => {
    const targetId = uniqueId('TST-TARGET-');
    activityLog.record('Test Actor', 'did something', 'unit_test', targetId, 'a plain create with no extra fields');
    const row = lastFor(targetId);
    expect(row.old_value).toBeNull();
    expect(row.new_value).toBeNull();
    expect(row.reason).toBeNull();
  });

  it('resolves department from a real seeded user name, and null for an unmatched actor', () => {
    const userId = uniqueId('TST-USR-');
    const userName = `Dept Test User ${userId}`;
    db.prepare(`INSERT INTO users (id, name, role, status) VALUES (?,?,?, 'ACTIVE')`).run(userId, userName, 'Warehouse Manager');

    const targetId = uniqueId('TST-TARGET-');
    activityLog.record(userName, 'did something', 'unit_test', targetId, 'a real user action');
    expect(lastFor(targetId).department).toBe('Warehouse Manager');

    const targetId2 = uniqueId('TST-TARGET-');
    activityLog.record('Some Unmatched Actor Name', 'did something', 'unit_test', targetId2, 'an unmatched actor');
    expect(lastFor(targetId2).department).toBeNull();
  });

  it('populates old_value/new_value/reason when explicitly passed (e.g. a reversal)', () => {
    const targetId = uniqueId('TST-TARGET-');
    activityLog.record('Test Actor', 'reversed', 'unit_test', targetId, 'reversed for test', {
      oldValue: JSON.stringify({ amount: 100 }), newValue: JSON.stringify({ amount: 0 }), reason: 'a sufficiently long reason for this test',
    });
    const row = lastFor(targetId);
    expect(row.old_value).toBe(JSON.stringify({ amount: 100 }));
    expect(row.new_value).toBe(JSON.stringify({ amount: 0 }));
    expect(row.reason).toBe('a sufficiently long reason for this test');
  });
});
