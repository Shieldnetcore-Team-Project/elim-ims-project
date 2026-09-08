import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as payroll from './payroll.js';

beforeAll(async () => { await ensureMigrated(); });

async function makeEmployee(): Promise<string> {
  const id = uniqueId('TST-EMP-');
  await db.prepare(`INSERT INTO employees (id, name, status) VALUES (?,?,'ACTIVE')`).run(id, 'Test Employee');
  return id;
}

describe('payroll deductions (Section 26)', () => {
  it('automatically applies a loan repayment deduction without it being entered manually', async () => {
    const empId = await makeEmployee();
    await payroll.createLoan({ employeeId: empId, principal: 60000, monthlyRepayment: 10000, actor: 'Test HR' });

    const run = await payroll.prepareRun({ staffId: empId, period: '2026-08', gross: 200000, preparedBy: 'Test HR' });
    const deductions = await payroll.listRunDeductions(run.id);
    expect(deductions).toHaveLength(1);
    expect(deductions[0]).toMatchObject({ type: 'LOAN', amount: 10000 });
    expect(run.total_deductions).toBe(10000);
    expect(run.net).toBe(190000);
  });

  it('caps the loan deduction at the outstanding balance, never over-deducting', async () => {
    const empId = await makeEmployee();
    const loan = await payroll.createLoan({ employeeId: empId, principal: 5000, monthlyRepayment: 10000, actor: 'Test HR' });
    expect(await payroll.outstanding(loan)).toBe(5000);

    const run = await payroll.prepareRun({ staffId: empId, period: '2026-08', gross: 100000, preparedBy: 'Test HR' });
    expect((await payroll.listRunDeductions(run.id))[0].amount).toBe(5000);
  });

  it('combines automatic (loan, compulsory savings) and manual (tax, penalty) deduction lines independently', async () => {
    const empId = await makeEmployee();
    await payroll.createLoan({ employeeId: empId, principal: 20000, monthlyRepayment: 5000, actor: 'Test HR' });
    await payroll.setSavingsPlan({ employeeId: empId, monthlyContribution: 2000, actor: 'Test HR' });

    const run = await payroll.prepareRun({
      staffId: empId, period: '2026-08', gross: 150000, preparedBy: 'Test HR',
      manualDeductions: [{ type: 'TAX', amount: 8000 }, { type: 'PENALTY', description: 'Late arrival', amount: 1000 }],
    });

    const deductions = await payroll.listRunDeductions(run.id);
    const byType = Object.fromEntries(deductions.map(d => [d.type, d.amount]));
    expect(byType).toEqual({ LOAN: 5000, COMPULSORY_SAVINGS: 2000, TAX: 8000, PENALTY: 1000 });
    expect(run.total_deductions).toBe(16000);
    expect(run.net).toBe(134000);
  });

  it('rejects LOAN/COMPULSORY_SAVINGS as manually-entered deduction types', async () => {
    const empId = await makeEmployee();
    await expect(payroll.prepareRun({
      staffId: empId, period: '2026-08', gross: 100000, preparedBy: 'Test HR',
      manualDeductions: [{ type: 'LOAN', amount: 5000 }],
    })).rejects.toThrow();
  });

  it('blocks a second run for the same staff and period unless the first was rejected', async () => {
    const empId = await makeEmployee();
    await payroll.prepareRun({ staffId: empId, period: '2026-09', gross: 100000, preparedBy: 'Test HR' });
    await expect(payroll.prepareRun({ staffId: empId, period: '2026-09', gross: 100000, preparedBy: 'Test HR' })).rejects.toThrow();
  });
});

describe('payroll approval workflow (Section 28)', () => {
  it('walks PENDING_REVIEW -> AWAITING_APPROVAL -> APPROVED -> DISBURSED, locking on approval', async () => {
    const empId = await makeEmployee();
    let run = await payroll.prepareRun({ staffId: empId, period: '2026-10', gross: 100000, preparedBy: 'Test HR' });
    expect(run.status).toBe('PENDING_REVIEW');
    expect(run.locked).toBe(0);

    run = await payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    expect(run.status).toBe('AWAITING_APPROVAL');

    run = await payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });
    expect(run.status).toBe('APPROVED');
    expect(run.locked).toBe(1);
    expect(run.approval_signature).toContain('Chairman Test');

    run = await payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' });
    expect(run.status).toBe('DISBURSED');
    expect(run.disbursed_by).toBe('Test Accounts');
  });

  it('only settles loan/savings balances at disbursement, never at approval', async () => {
    const empId = await makeEmployee();
    const loan = await payroll.createLoan({ employeeId: empId, principal: 20000, monthlyRepayment: 5000, actor: 'Test HR' });
    let run = await payroll.prepareRun({ staffId: empId, period: '2026-11', gross: 100000, preparedBy: 'Test HR' });
    run = await payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    run = await payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });

    expect((await payroll.getLoan(loan.id))!.amount_repaid).toBe(0); // not yet disbursed

    await payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' });
    expect((await payroll.getLoan(loan.id))!.amount_repaid).toBe(5000);
  });

  it('rejects out-of-order transitions', async () => {
    const empId = await makeEmployee();
    const run = await payroll.prepareRun({ staffId: empId, period: '2026-12', gross: 100000, preparedBy: 'Test HR' });
    await expect(payroll.approveRun(run.id, { approvedBy: 'Chairman Test' })).rejects.toThrow();
    await expect(payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' })).rejects.toThrow();
  });

  it('blocks revising a run that is not locked, and preserves the original untouched', async () => {
    const empId = await makeEmployee();
    const run = await payroll.prepareRun({ staffId: empId, period: '2027-01', gross: 100000, preparedBy: 'Test HR' });
    await expect(payroll.reviseRun(run.id, { gross: 120000, preparedBy: 'Test HR', reason: 'correction' })).rejects.toThrow();

    await payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    const approved = await payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });

    const revision = await payroll.reviseRun(approved.id, { gross: 120000, preparedBy: 'Test HR', reason: 'gross was understated' });
    expect(revision.revision_of).toBe(approved.id);
    expect(revision.status).toBe('PENDING_REVIEW');
    expect(revision.gross).toBe(120000);

    // The original is completely untouched.
    const originalAfter = (await payroll.getRun(approved.id))!;
    expect(originalAfter.gross).toBe(100000);
    expect(originalAfter.status).toBe('APPROVED');
    expect(originalAfter.locked).toBe(1);
  });
});

describe('compulsory savings liquidation (Section 27)', () => {
  it('zeroes current_balance, keeps total_contribution, and records who/when — without deleting history', async () => {
    const empId = await makeEmployee();
    await payroll.setSavingsPlan({ employeeId: empId, monthlyContribution: 3000, actor: 'Test HR' });

    let run = await payroll.prepareRun({ staffId: empId, period: '2026-08', gross: 100000, preparedBy: 'Test HR' });
    run = await payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    run = await payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });
    await payroll.disburseRun(run.id, { disbursedBy: 'Test Accounts' });

    let savings = (await payroll.getSavings(empId))!;
    expect(savings.current_balance).toBe(3000);
    expect(savings.total_contribution).toBe(3000);

    const results = await payroll.liquidateSavings({ authorizedBy: 'Test Chairman' });
    expect(results.some(r => r.employeeId === empId && r.amount === 3000)).toBe(true);

    savings = (await payroll.getSavings(empId))!;
    expect(savings.current_balance).toBe(0);
    expect(savings.total_contribution).toBe(3000); // never decreases

    const txns = await payroll.savingsTransactions(empId);
    expect(txns.some(t => t.type === 'CONTRIBUTION' && t.amount === 3000)).toBe(true);
    expect(txns.some(t => t.type === 'LIQUIDATION' && t.amount === 3000 && t.authorized_by === 'Test Chairman')).toBe(true);
  });

  it('reads the configured liquidation date rather than hard-coding January 1st', async () => {
    await db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Compulsory savings liquidation date', 'test', '06-30', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
    expect(await payroll.liquidationDate()).toBe('06-30');
    await db.prepare(`
      INSERT INTO settings (id, description, value, updated_by, status) VALUES ('Compulsory savings liquidation date', 'test', '01-01', 'Test', 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run();
  });
});

describe('payroll export (Section 29)', () => {
  it('only includes bank details once the run is authorized (APPROVED or DISBURSED)', async () => {
    const empId = await makeEmployee();
    await db.prepare('UPDATE employees SET bank_name = ?, bank_account_number = ? WHERE id = ?').run('Test Bank', '0123456789', empId);

    const period = uniqueId('2099-');
    let run = await payroll.prepareRun({ staffId: empId, period, gross: 100000, preparedBy: 'Test HR' });
    let rows = await payroll.exportSummary(period);
    expect(rows.find(r => r.payroll_run_id === run.id)!.bank_name).toBeNull();

    run = await payroll.reviewRun(run.id, { reviewedBy: 'Test Payroll Officer' });
    run = await payroll.approveRun(run.id, { approvedBy: 'Chairman Test' });
    rows = await payroll.exportSummary(period);
    expect(rows.find(r => r.payroll_run_id === run.id)!.bank_name).toBe('Test Bank');
  });

  it('provides a detailed deduction schedule as separate rows, not folded into one total', async () => {
    const empId = await makeEmployee();
    await payroll.createLoan({ employeeId: empId, principal: 20000, monthlyRepayment: 5000, actor: 'Test HR' });
    const period = uniqueId('2098-');
    const run = await payroll.prepareRun({
      staffId: empId, period, gross: 100000, preparedBy: 'Test HR',
      manualDeductions: [{ type: 'TAX', amount: 3000 }],
    });
    const schedule = await payroll.exportDeductionSchedule(period);
    expect(schedule.filter(s => s.payroll_run_id === run.id)).toHaveLength(2);
  });
});
