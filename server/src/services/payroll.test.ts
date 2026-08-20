import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as payroll from './payroll.js';

beforeAll(() => ensureMigrated());

function makeEmployee(): string {
  const id = uniqueId('TST-EMP-');
  db.prepare(`INSERT INTO employees (id, name, status) VALUES (?,?,'ACTIVE')`).run(id, 'Test Employee');
  return id;
}

describe('payroll deductions (Section 26)', () => {
  it('automatically applies a loan repayment deduction without it being entered manually', () => {
    const empId = makeEmployee();
    payroll.createLoan({ employeeId: empId, principal: 60000, monthlyRepayment: 10000, actor: 'Test HR' });

    const run = payroll.prepareRun({ staffId: empId, period: '2026-08', gross: 200000, preparedBy: 'Test HR' });
    const deductions = payroll.listRunDeductions(run.id);
    expect(deductions).toHaveLength(1);
    expect(deductions[0]).toMatchObject({ type: 'LOAN', amount: 10000 });
    expect(run.total_deductions).toBe(10000);
    expect(run.net).toBe(190000);
  });

  it('caps the loan deduction at the outstanding balance, never over-deducting', () => {
    const empId = makeEmployee();
    const loan = payroll.createLoan({ employeeId: empId, principal: 5000, monthlyRepayment: 10000, actor: 'Test HR' });
    expect(payroll.outstanding(loan)).toBe(5000);

    const run = payroll.prepareRun({ staffId: empId, period: '2026-08', gross: 100000, preparedBy: 'Test HR' });
    expect(payroll.listRunDeductions(run.id)[0].amount).toBe(5000);
  });

  it('combines automatic (loan, compulsory savings) and manual (tax, penalty) deduction lines independently', () => {
    const empId = makeEmployee();
    payroll.createLoan({ employeeId: empId, principal: 20000, monthlyRepayment: 5000, actor: 'Test HR' });
    payroll.setSavingsPlan({ employeeId: empId, monthlyContribution: 2000, actor: 'Test HR' });

    const run = payroll.prepareRun({
      staffId: empId, period: '2026-08', gross: 150000, preparedBy: 'Test HR',
      manualDeductions: [{ type: 'TAX', amount: 8000 }, { type: 'PENALTY', description: 'Late arrival', amount: 1000 }],
    });

    const deductions = payroll.listRunDeductions(run.id);
    const byType = Object.fromEntries(deductions.map(d => [d.type, d.amount]));
    expect(byType).toEqual({ LOAN: 5000, COMPULSORY_SAVINGS: 2000, TAX: 8000, PENALTY: 1000 });
    expect(run.total_deductions).toBe(16000);
    expect(run.net).toBe(134000);
  });

  it('rejects LOAN/COMPULSORY_SAVINGS as manually-entered deduction types', () => {
    const empId = makeEmployee();
    expect(() => payroll.prepareRun({
      staffId: empId, period: '2026-08', gross: 100000, preparedBy: 'Test HR',
      manualDeductions: [{ type: 'LOAN', amount: 5000 }],
    })).toThrow();
  });

  it('blocks a second run for the same staff and period unless the first was rejected', () => {
    const empId = makeEmployee();
    payroll.prepareRun({ staffId: empId, period: '2026-09', gross: 100000, preparedBy: 'Test HR' });
    expect(() => payroll.prepareRun({ staffId: empId, period: '2026-09', gross: 100000, preparedBy: 'Test HR' })).toThrow();
  });
});

describe('payroll approval workflow (Section 28)', () => {
  it('walks PENDING_REVIEW -> AWAITING_APPROVAL -> APPROVED -> DISBURSED, locking on approval', () => {
    const empId = makeEmployee();
    let run = payroll.prepareRun({ staffId: empId, period: '2026-10', gross: 100000, preparedBy: 'Test HR' });
    expect(run.status).toBe('PENDING_REVIEW');
    expect(run.locked).toBe(0);

    run = payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    expect(run.status).toBe('AWAITING_APPROVAL');

    run = payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });
    expect(run.status).toBe('APPROVED');
    expect(run.locked).toBe(1);
    expect(run.approval_signature).toContain('Chairman Test');

    run = payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' });
    expect(run.status).toBe('DISBURSED');
    expect(run.disbursed_by).toBe('Test Accounts');
  });

  it('only settles loan/savings balances at disbursement, never at approval', () => {
    const empId = makeEmployee();
    const loan = payroll.createLoan({ employeeId: empId, principal: 20000, monthlyRepayment: 5000, actor: 'Test HR' });
    let run = payroll.prepareRun({ staffId: empId, period: '2026-11', gross: 100000, preparedBy: 'Test HR' });
    run = payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    run = payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });

    expect(payroll.getLoan(loan.id)!.amount_repaid).toBe(0); // not yet disbursed

    payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' });
    expect(payroll.getLoan(loan.id)!.amount_repaid).toBe(5000);
  });

  it('rejects out-of-order transitions', () => {
    const empId = makeEmployee();
    const run = payroll.prepareRun({ staffId: empId, period: '2026-12', gross: 100000, preparedBy: 'Test HR' });
    expect(() => payroll.approveRun(run.id, { approvedBy: 'Chairman Test' })).toThrow();
    expect(() => payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' })).toThrow();
  });

  it('blocks revising a run that is not locked, and preserves the original untouched', () => {
    const empId = makeEmployee();
    const run = payroll.prepareRun({ staffId: empId, period: '2027-01', gross: 100000, preparedBy: 'Test HR' });
    expect(() => payroll.reviseRun(run.id, { gross: 120000, preparedBy: 'Test HR', reason: 'correction' })).toThrow();

    payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    const approved = payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });

    const revision = payroll.reviseRun(approved.id, { gross: 120000, preparedBy: 'Test HR', reason: 'gross was understated' });
    expect(revision.revision_of).toBe(approved.id);
    expect(revision.status).toBe('PENDING_REVIEW');
    expect(revision.gross).toBe(120000);

    // The original is completely untouched.
    const originalAfter = payroll.getRun(approved.id)!;
    expect(originalAfter.gross).toBe(100000);
    expect(originalAfter.status).toBe('APPROVED');
    expect(originalAfter.locked).toBe(1);
  });
});

describe('compulsory savings liquidation (Section 27)', () => {
  it('zeroes current_balance, keeps total_contribution, and records who/when — without deleting history', () => {
    const empId = makeEmployee();
    payroll.setSavingsPlan({ employeeId: empId, monthlyContribution: 3000, actor: 'Test HR' });

    let run = payroll.prepareRun({ staffId: empId, period: '2026-08', gross: 100000, preparedBy: 'Test HR' });
    run = payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    run = payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });
    payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' });

    let savings = payroll.getSavings(empId)!;
    expect(savings.current_balance).toBe(3000);
    expect(savings.total_contribution).toBe(3000);

    const results = payroll.liquidateSavings({ authorizedBy: 'Test Chairman' });
    expect(results.some(r => r.employeeId === empId && r.amount === 3000)).toBe(true);

    savings = payroll.getSavings(empId)!;
    expect(savings.current_balance).toBe(0);
    expect(savings.total_contribution).toBe(3000); // never decreases

    const txns = payroll.savingsTransactions(empId);
    expect(txns.some(t => t.type === 'CONTRIBUTION' && t.amount === 3000)).toBe(true);
    expect(txns.some(t => t.type === 'LIQUIDATION' && t.amount === 3000 && t.authorized_by === 'Test Chairman')).toBe(true);
  });

  it('reads the configured liquidation date rather than hard-coding January 1st', () => {
    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Compulsory savings liquidation date', 'test', '06-30', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
    expect(payroll.liquidationDate()).toBe('06-30');
    db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Compulsory savings liquidation date', 'test', '01-01', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
  });
});

describe('payroll export (Section 29)', () => {
  it('only includes bank details once the run is authorized (APPROVED or DISBURSED)', () => {
    const empId = makeEmployee();
    db.prepare('UPDATE employees SET bank_name = ?, bank_account_number = ? WHERE id = ?').run('Test Bank', '0123456789', empId);

    const period = uniqueId('2099-');
    let run = payroll.prepareRun({ staffId: empId, period, gross: 100000, preparedBy: 'Test HR' });
    let rows = payroll.exportSummary(period);
    expect(rows.find(r => r.payroll_run_id === run.id)!.bank_name).toBeNull();

    run = payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    run = payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });
    rows = payroll.exportSummary(period);
    expect(rows.find(r => r.payroll_run_id === run.id)!.bank_name).toBe('Test Bank');
  });

  it('provides a detailed deduction schedule as separate rows, not folded into one total', () => {
    const empId = makeEmployee();
    payroll.createLoan({ employeeId: empId, principal: 20000, monthlyRepayment: 5000, actor: 'Test HR' });
    const period = uniqueId('2098-');
    const run = payroll.prepareRun({
      staffId: empId, period, gross: 100000, preparedBy: 'Test HR',
      manualDeductions: [{ type: 'TAX', amount: 3000 }],
    });
    const schedule = payroll.exportDeductionSchedule(period);
    expect(schedule.filter(s => s.payroll_run_id === run.id)).toHaveLength(2);
  });
});
