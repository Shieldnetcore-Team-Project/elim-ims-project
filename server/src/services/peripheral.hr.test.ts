import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as peripheral from './peripheral.js';

beforeAll(() => ensureMigrated());

describe('HR: computed tenure (Section 25 — "do not use Tenure as a manually maintained field")', () => {
  it('computes tenure from date_engaged, ignoring whatever is stored in the legacy tenure column', () => {
    const id = uniqueId('TST-EMP-');
    db.prepare(`INSERT INTO employees (id, name, tenure, date_engaged, status) VALUES (?,?,?,?,'ACTIVE')`)
      .run(id, 'Test Employee', 'this stale value must be ignored', '2020-01-15');

    const row = peripheral.get('hr', id)!;
    expect(row.fields.tenure).not.toBe('this stale value must be ignored');
    expect(String(row.fields.tenure)).toMatch(/yr/);
  });

  it('computes tenure up to date_disengaged, not today, once an employee has left', () => {
    const id = uniqueId('TST-EMP-');
    db.prepare(`INSERT INTO employees (id, name, date_engaged, date_disengaged, status) VALUES (?,?,?,?,'RESIGNED')`)
      .run(id, 'Test Departed Employee', '2022-01-01', '2022-07-01');

    const row = peripheral.get('hr', id)!;
    expect(row.fields.tenure).toBe('6 mos');
  });

  it('reads the configured status list rather than a hard-coded set', () => {
    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Employee status options', 'test', 'Onboarding,Probation,Confirmed', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
    expect(peripheral.employeeStatusOptions()).toEqual([
      { value: 'ONBOARDING', label: 'Onboarding' },
      { value: 'PROBATION', label: 'Probation' },
      { value: 'CONFIRMED', label: 'Confirmed' },
    ]);

    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Employee status options', 'test', 'Active,Inactive,On Leave,Resigned,Terminated,Disengaged,Absconded', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
  });
});
