import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as finance from './finance.js';

export type DeductionType = 'LOAN' | 'SALARY_ADVANCE' | 'SAVINGS' | 'COMPULSORY_SAVINGS' | 'TAX' | 'PENALTY' | 'OTHER';
export type PayrollStatus = 'PENDING_REVIEW' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DISBURSED';

export interface Loan {
  id: string; employee_id: string; principal: number; date_issued: string; repayment_schedule: string | null;
  monthly_repayment: number; amount_repaid: number; status: 'ACTIVE' | 'PAID_OFF' | 'WRITTEN_OFF'; created_at: string;
}
export interface EmployeeSavings {
  employee_id: string; monthly_contribution: number; start_date: string | null;
  current_balance: number; total_contribution: number; status: 'ACTIVE' | 'INACTIVE';
}
export interface SavingsTransaction {
  id: string; employee_id: string; type: 'CONTRIBUTION' | 'LIQUIDATION'; amount: number;
  payroll_run_id: string | null; authorized_by: string | null; paid_date: string | null; created_at: string;
}
export interface PayrollDeduction { id: number; payroll_run_id: string; type: DeductionType; description: string | null; amount: number; reference_id: string | null }
export interface PayrollRun {
  id: string; staff_id: string; staff_name: string | null; period: string; gross: number; total_deductions: number; net: number;
  status: PayrollStatus; prepared_by: string | null; reviewed_by: string | null; reviewed_at: string | null;
  approved_by: string | null; approved_at: string | null; approval_signature: string | null;
  disbursed_by: string | null; disbursed_at: string | null; locked: number; revision_of: string | null; created_at: string;
}

// ===================== Loans =====================

export function outstanding(loan: Pick<Loan, 'principal' | 'amount_repaid'>): number {
  return Math.max(loan.principal - loan.amount_repaid, 0);
}

/** Section 26 worked example: "Loan record: Principal, Date, Repayment
 *  Schedule, Amount Repaid, Outstanding" — Outstanding is always derived
 *  (principal - amount_repaid), never stored. */
export async function createLoan(params: {
  employeeId: string; principal: number; repaymentSchedule?: string; monthlyRepayment: number; actor: string;
}): Promise<Loan> {
  if (params.principal <= 0) throw new Error('Principal must be positive');
  if (params.monthlyRepayment <= 0) throw new Error('Monthly repayment must be positive');
  const id = await nextBusinessId('loans', 'LN-', 4);
  await db.prepare(`INSERT INTO loans (id, employee_id, principal, repayment_schedule, monthly_repayment, actor) VALUES (?,?,?,?,?,?)`)
    .run(id, params.employeeId, params.principal, params.repaymentSchedule ?? null, params.monthlyRepayment, params.actor);
  await activityLog.record(params.actor, 'issued loan to', 'employee', params.employeeId, `${id}: ₦${params.principal.toLocaleString('en-NG')} principal, ₦${params.monthlyRepayment.toLocaleString('en-NG')}/month`);
  return (await getLoan(id))!;
}

export async function getLoan(id: string): Promise<Loan | undefined> {
  return await db.prepare('SELECT * FROM loans WHERE id = ?').get(id) as Loan | undefined;
}

export async function listLoans(employeeId?: string): Promise<(Loan & { employee_name: string; outstanding: number })[]> {
  const rows = (employeeId
    ? await db.prepare('SELECT l.*, e.name AS employee_name FROM loans l JOIN employees e ON e.id = l.employee_id WHERE l.employee_id = ? ORDER BY l.id DESC').all(employeeId)
    : await db.prepare('SELECT l.*, e.name AS employee_name FROM loans l JOIN employees e ON e.id = l.employee_id ORDER BY l.id DESC').all()) as unknown as (Loan & { employee_name: string })[];
  return rows.map(l => ({ ...l, outstanding: outstanding(l) }));
}

// ===================== Compulsory Savings =====================

export async function getSavings(employeeId: string): Promise<EmployeeSavings | undefined> {
  return await db.prepare('SELECT * FROM employee_savings WHERE employee_id = ?').get(employeeId) as EmployeeSavings | undefined;
}

export async function listSavings(): Promise<(EmployeeSavings & { employee_name: string })[]> {
  return await db.prepare(`
    SELECT es.*, e.name AS employee_name FROM employee_savings es JOIN employees e ON e.id = es.employee_id ORDER BY e.name
  `).all() as unknown as (EmployeeSavings & { employee_name: string })[];
}

/** Sets up or updates an employee's ongoing compulsory savings plan — the
 *  "Savings Rate/Amount, Start Date" half of Section 26/27; current_balance
 *  and total_contribution are only ever moved by payroll disbursement
 *  (CONTRIBUTION) or liquidateSavings() (LIQUIDATION), never here. */
export async function setSavingsPlan(params: { employeeId: string; monthlyContribution: number; startDate?: string; actor: string }): Promise<EmployeeSavings> {
  if (params.monthlyContribution < 0) throw new Error('Monthly contribution cannot be negative');
  const existing = await getSavings(params.employeeId);
  if (existing) {
    await db.prepare('UPDATE employee_savings SET monthly_contribution = ?, start_date = COALESCE(?, start_date) WHERE employee_id = ?')
      .run(params.monthlyContribution, params.startDate ?? null, params.employeeId);
  } else {
    await db.prepare('INSERT INTO employee_savings (employee_id, monthly_contribution, start_date) VALUES (?,?,?)')
      .run(params.employeeId, params.monthlyContribution, params.startDate ?? new Date().toISOString().slice(0, 10));
  }
  await activityLog.record(params.actor, 'set compulsory savings plan for', 'employee', params.employeeId, `₦${params.monthlyContribution.toLocaleString('en-NG')}/month`);
  return (await getSavings(params.employeeId))!;
}

export async function savingsTransactions(employeeId: string): Promise<SavingsTransaction[]> {
  return await db.prepare('SELECT * FROM employee_savings_transactions WHERE employee_id = ? ORDER BY id DESC').all(employeeId) as unknown as SavingsTransaction[];
}

const DEFAULT_LIQUIDATION_DATE = '01-01';

/** MM-DD — configurable per "the system should support a configurable
 *  annual liquidation date," read from Settings rather than hard-coded to
 *  January 1st even though that's the company's current stated policy. */
export async function liquidationDate(): Promise<string> {
  const row = await db.prepare(`SELECT value FROM settings WHERE id = 'Compulsory savings liquidation date'`).get() as { value: string } | undefined;
  return row?.value.trim() || DEFAULT_LIQUIDATION_DATE;
}

/** Company policy: "savings are liquidated at the beginning of January."
 *  Every employee with a positive balance gets a LIQUIDATION transaction
 *  for the full amount, current_balance goes to zero, total_contribution is
 *  untouched (it's the lifetime figure — "do not delete previous savings
 *  history"). An authorized person and a real payment date are required;
 *  nothing here is automatic/scheduled — this app has no background job
 *  runner, so liquidation is a deliberate action someone takes on or after
 *  the configured date, not a silent cron job. */
export async function liquidateSavings(params: { authorizedBy: string; actor?: string }): Promise<{ employeeId: string; amount: number }[]> {
  if (!params.authorizedBy || !params.authorizedBy.trim()) throw new Error('An authorized person is required to liquidate savings');
  const actor = params.actor ?? params.authorizedBy;
  const toLiquidate = await db.prepare(`SELECT employee_id, current_balance FROM employee_savings WHERE current_balance > 0`).all() as { employee_id: string; current_balance: number }[];
  if (toLiquidate.length === 0) return [];

  return await db.transaction(async () => {
    const insertTxn = db.prepare('INSERT INTO employee_savings_transactions (id, employee_id, type, amount, authorized_by, paid_date) VALUES (?,?,?,?,?,now())');
    const results: { employeeId: string; amount: number }[] = [];
    for (const row of toLiquidate) {
      const id = await nextBusinessId('employee_savings_transactions', 'SVL-', 5);
      await insertTxn.run(id, row.employee_id, 'LIQUIDATION', row.current_balance, params.authorizedBy);
      await db.prepare('UPDATE employee_savings SET current_balance = 0 WHERE employee_id = ?').run(row.employee_id);
      results.push({ employeeId: row.employee_id, amount: row.current_balance });
    }
    await activityLog.record(actor, 'liquidated compulsory savings', 'employee_savings', 'ALL',
      `${results.length} employee(s), ₦${results.reduce((s, r) => s + r.amount, 0).toLocaleString('en-NG')} total, authorized by ${params.authorizedBy}`);
    return results;
  });
}

// ===================== Payroll runs =====================

/** LOAN and COMPULSORY_SAVINGS lines are computed automatically — "Payroll
 *  automatically applies the appropriate deduction" — everything else
 *  (Salary Advance, Tax, Penalty, ad-hoc Savings, Other Approved) is
 *  whatever the preparer explicitly entered. Shared by prepareRun() and
 *  reviseRun() so a revision recomputes the same way a fresh run would. */
async function computeDeductionLines(staffId: string, manualDeductions: { type: DeductionType; description?: string; amount: number }[]): Promise<{ type: DeductionType; description: string | null; amount: number; referenceId: string | null }[]> {
  const lines: { type: DeductionType; description: string | null; amount: number; referenceId: string | null }[] = [];

  const loans = await db.prepare(`SELECT * FROM loans WHERE employee_id = ? AND status = 'ACTIVE'`).all(staffId) as unknown as Loan[];
  for (const loan of loans) {
    const owed = outstanding(loan);
    if (owed <= 0) continue;
    const amount = Math.min(loan.monthly_repayment, owed);
    if (amount > 0) lines.push({ type: 'LOAN', description: `${loan.id} repayment`, amount, referenceId: loan.id });
  }

  const savings = await getSavings(staffId);
  if (savings && savings.status === 'ACTIVE' && savings.monthly_contribution > 0) {
    lines.push({ type: 'COMPULSORY_SAVINGS', description: 'Monthly compulsory savings contribution', amount: savings.monthly_contribution, referenceId: staffId });
  }

  for (const d of manualDeductions) {
    if (d.type === 'LOAN' || d.type === 'COMPULSORY_SAVINGS') throw new Error(`${d.type} is applied automatically and cannot be entered manually`);
    if (d.amount <= 0) continue;
    lines.push({ type: d.type, description: d.description ?? null, amount: d.amount, referenceId: null });
  }

  return lines;
}

async function insertRun(params: {
  id: string; staffId: string; staffName: string; period: string; gross: number; preparedBy: string;
  lines: { type: DeductionType; description: string | null; amount: number; referenceId: string | null }[];
  revisionOf?: string;
}): Promise<void> {
  const totalDeductions = params.lines.reduce((s, l) => s + l.amount, 0);
  const net = params.gross - totalDeductions;
  if (net < 0) throw new Error(`Deductions (₦${totalDeductions.toLocaleString('en-NG')}) exceed gross salary (₦${params.gross.toLocaleString('en-NG')})`);

  await db.prepare(`
    INSERT INTO payroll_runs (id, staff_id, staff_name, period, gross, total_deductions, net, status, prepared_by, revision_of)
    VALUES (?,?,?,?,?,?,?,'PENDING_REVIEW',?,?)
  `).run(params.id, params.staffId, params.staffName, params.period, params.gross, totalDeductions, net, params.preparedBy, params.revisionOf ?? null);
  const insertDeduction = db.prepare('INSERT INTO payroll_deductions (payroll_run_id, type, description, amount, reference_id) VALUES (?,?,?,?,?)');
  for (const l of params.lines) await insertDeduction.run(params.id, l.type, l.description, l.amount, l.referenceId);
}

/** Step one of Module 28: "HR/Accounts prepares payroll" — lands directly in
 *  PENDING_REVIEW (the review queue), since there's no separate draft-editing
 *  UI asked for. One run per staff member per period (a REJECTED run doesn't
 *  count against that — the same period can simply be re-prepared). */
export async function prepareRun(params: {
  staffId: string; period: string; gross: number;
  manualDeductions?: { type: DeductionType; description?: string; amount: number }[];
  preparedBy: string; actor?: string;
}): Promise<PayrollRun> {
  if (params.gross <= 0) throw new Error('Gross salary must be positive');
  const staff = await db.prepare('SELECT name FROM employees WHERE id = ?').get(params.staffId) as { name: string } | undefined;
  if (!staff) throw new Error(`Unknown employee ${params.staffId}`);
  const existing = await db.prepare(`SELECT id FROM payroll_runs WHERE staff_id = ? AND period = ? AND status != 'REJECTED'`).get(params.staffId, params.period);
  if (existing) throw new Error(`A payroll run already exists for ${staff.name} for ${params.period}`);

  const lines = await computeDeductionLines(params.staffId, params.manualDeductions ?? []);
  const id = await nextBusinessId('payroll_runs', 'PYR-2026-', 4);
  const actor = params.actor ?? params.preparedBy;
  await db.transaction(async () => {
    await insertRun({ id, staffId: params.staffId, staffName: staff.name, period: params.period, gross: params.gross, preparedBy: params.preparedBy, lines });
    await activityLog.record(actor, 'prepared payroll for', 'employee', params.staffId, `${id}: ${params.period}, gross ₦${params.gross.toLocaleString('en-NG')}`);
  });
  return (await getRun(id))!;
}

export async function getRun(id: string): Promise<PayrollRun | undefined> {
  return await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id) as PayrollRun | undefined;
}

export async function listRunDeductions(runId: string): Promise<PayrollDeduction[]> {
  return await db.prepare('SELECT * FROM payroll_deductions WHERE payroll_run_id = ?').all(runId) as unknown as PayrollDeduction[];
}

export async function listRuns(period?: string): Promise<PayrollRun[]> {
  if (period) return await db.prepare('SELECT * FROM payroll_runs WHERE period = ? ORDER BY id DESC').all(period) as unknown as PayrollRun[];
  return await db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC').all() as unknown as PayrollRun[];
}

function requireStatus(run: PayrollRun, expected: PayrollStatus): void {
  if (run.status !== expected) throw new Error(`${run.id} is ${run.status}, not ${expected}`);
}

/** Step two: Payroll review — PENDING_REVIEW -> AWAITING_APPROVAL, the
 *  Chairman's queue. */
export async function reviewRun(id: string, params: { reviewedBy: string; actor?: string }): Promise<PayrollRun> {
  const run = await getRun(id);
  if (!run) throw new Error(`Unknown payroll run ${id}`);
  requireStatus(run, 'PENDING_REVIEW');
  const actor = params.actor ?? params.reviewedBy;
  await db.prepare(`UPDATE payroll_runs SET status = 'AWAITING_APPROVAL', reviewed_by = ?, reviewed_at = now() WHERE id = ?`).run(params.reviewedBy, id);
  await activityLog.record(actor, 'reviewed payroll', 'payroll_run', id, `${id} sent for Chairman approval by ${params.reviewedBy}`);
  return (await getRun(id))!;
}

/** Reads the configured template (Settings -> "Payroll approval signature
 *  format") rather than a fixed string — "generate approval signature/
 *  representation according to the company's configured policy." */
async function generateApprovalSignature(approver: string): Promise<string> {
  const row = await db.prepare(`SELECT value FROM settings WHERE id = 'Payroll approval signature format'`).get() as { value: string } | undefined;
  const template = row?.value || 'Digitally approved by {approver} on {date}';
  return template.replace('{approver}', approver).replace('{date}', new Date().toISOString().slice(0, 10));
}

/** Step three: Chairman approval — digital, no paper signature required.
 *  Locks the run (locked=1) the moment it's approved: "approved payroll
 *  should not be silently modified" from here on, only reviseRun() can
 *  supersede it, and only with a brand-new linked row. */
export async function approveRun(id: string, params: { approvedBy: string; actor?: string }): Promise<PayrollRun> {
  const run = await getRun(id);
  if (!run) throw new Error(`Unknown payroll run ${id}`);
  requireStatus(run, 'AWAITING_APPROVAL');
  const actor = params.actor ?? params.approvedBy;
  const signature = await generateApprovalSignature(params.approvedBy);
  await db.prepare(`UPDATE payroll_runs SET status = 'APPROVED', approved_by = ?, approved_at = now(), approval_signature = ?, locked = 1 WHERE id = ?`)
    .run(params.approvedBy, signature, id);
  await activityLog.record(actor, 'approved payroll', 'payroll_run', id, `${id} approved by ${params.approvedBy} — ${signature}`);
  return (await getRun(id))!;
}

export async function rejectRun(id: string, params: { reason: string; actor: string }): Promise<PayrollRun> {
  const run = await getRun(id);
  if (!run) throw new Error(`Unknown payroll run ${id}`);
  requireStatus(run, 'AWAITING_APPROVAL');
  if (!params.reason || !params.reason.trim()) throw new Error('A reason is required to reject payroll');
  await db.prepare(`UPDATE payroll_runs SET status = 'REJECTED' WHERE id = ?`).run(id);
  await activityLog.record(params.actor, 'rejected payroll', 'payroll_run', id, `${id} rejected — ${params.reason.trim()}`);
  return (await getRun(id))!;
}

/** Step four: Accounts disbursement — the one point real money/balances
 *  move. Loan and Compulsory Savings deduction lines settle here (loan
 *  amount_repaid increments, savings current_balance/total_contribution
 *  increment) — never earlier, so a run that's rejected before disbursement
 *  never falsely credits either. Posts to the general ledger: Dr Salaries
 *  expense (gross) / Cr Payroll deductions payable (total_deductions) / Cr
 *  Cash/Bank (net) — deductions payable is the holding account for what
 *  still has to be remitted (loan books, tax authority, savings account). */
export async function disburseRun(id: string, params: { disbursedBy: string; actor?: string }): Promise<PayrollRun> {
  const run = await getRun(id);
  if (!run) throw new Error(`Unknown payroll run ${id}`);
  requireStatus(run, 'APPROVED');
  const actor = params.actor ?? params.disbursedBy;
  const lines = await listRunDeductions(id);

  await db.transaction(async () => {
    for (const line of lines) {
      if (line.type === 'LOAN' && line.reference_id) {
        const loan = await getLoan(line.reference_id);
        if (loan) {
          const newRepaid = loan.amount_repaid + line.amount;
          const newStatus = newRepaid >= loan.principal ? 'PAID_OFF' : loan.status;
          await db.prepare('UPDATE loans SET amount_repaid = ?, status = ? WHERE id = ?').run(newRepaid, newStatus, loan.id);
        }
      }
      if (line.type === 'COMPULSORY_SAVINGS') {
        const savingsId = await nextBusinessId('employee_savings_transactions', 'SVC-', 5);
        await db.prepare(`INSERT INTO employee_savings_transactions (id, employee_id, type, amount, payroll_run_id, paid_date) VALUES (?,?,?,?,?,now())`)
          .run(savingsId, run.staff_id, 'CONTRIBUTION', line.amount, id);
        await db.prepare('UPDATE employee_savings SET current_balance = current_balance + ?, total_contribution = total_contribution + ? WHERE employee_id = ?')
          .run(line.amount, line.amount, run.staff_id);
      }
    }

    if (run.gross > 0) {
      await finance.postLedger({ account: 'Salaries expense', debit: run.gross, credit: 0, referenceType: 'payroll_run', referenceId: id, description: `Payroll ${id} — ${run.staff_name} (${run.period})`, actor });
      if (run.total_deductions > 0) {
        await finance.postLedger({ account: 'Payroll deductions payable', debit: 0, credit: run.total_deductions, referenceType: 'payroll_run', referenceId: id, description: `Payroll ${id} deductions`, actor });
      }
      await finance.postLedger({ account: 'Cash/Bank', debit: 0, credit: run.net, referenceType: 'payroll_run', referenceId: id, description: `Payroll ${id} net pay`, actor });
    }

    await db.prepare(`UPDATE payroll_runs SET status = 'DISBURSED', disbursed_by = ?, disbursed_at = now() WHERE id = ?`).run(params.disbursedBy, id);
    await activityLog.record(actor, 'disbursed payroll', 'payroll_run', id, `${id} disbursed by ${params.disbursedBy} — net ₦${run.net.toLocaleString('en-NG')}`);
  });
  return (await getRun(id))!;
}

/** The controlled revision workflow: only callable against a locked
 *  (APPROVED or DISBURSED) run — the original row is never touched, a brand
 *  new PENDING_REVIEW row is created pointing back via revision_of, and has
 *  to go through review/approval/disbursement again from scratch. */
export async function reviseRun(originalId: string, params: {
  gross: number; manualDeductions?: { type: DeductionType; description?: string; amount: number }[];
  preparedBy: string; reason: string; actor?: string;
}): Promise<PayrollRun> {
  const original = await getRun(originalId);
  if (!original) throw new Error(`Unknown payroll run ${originalId}`);
  if (!original.locked) throw new Error(`${originalId} is not locked — edit it directly rather than revising it`);
  if (!params.reason || !params.reason.trim()) throw new Error('A reason is required to revise payroll');
  if (params.gross <= 0) throw new Error('Gross salary must be positive');

  const lines = await computeDeductionLines(original.staff_id, params.manualDeductions ?? []);
  const id = await nextBusinessId('payroll_runs', 'PYR-2026-', 4);
  const actor = params.actor ?? params.preparedBy;
  await db.transaction(async () => {
    await insertRun({ id, staffId: original.staff_id, staffName: original.staff_name ?? '', period: original.period, gross: params.gross, preparedBy: params.preparedBy, lines, revisionOf: originalId });
    await activityLog.record(actor, 'raised a revision of', 'payroll_run', originalId, `${id} revises ${originalId} — ${params.reason.trim()}`, { reason: params.reason.trim() });
  });
  return (await getRun(id))!;
}

// ===================== Export (Section 29) =====================

export interface PayrollExportRow {
  payroll_run_id: string; employee_id: string; employee_name: string; period: string;
  gross: number; total_deductions: number; net: number; status: PayrollStatus;
  bank_name: string | null; bank_account_number: string | null;
}

/** Section 29: "Employee, Gross, Deductions, Net, Bank/Payment information
 *  where authorized, Status." Bank details are only included once the run
 *  is APPROVED or DISBURSED — "where authorized" reads as "once the payroll
 *  has actually been authorized for payment," not for a run still under
 *  review that nobody's signed off on releasing money against. The client
 *  turns this straight into an Excel file via the existing csv/Excel export
 *  helpers — no new export format is invented here. */
export async function exportSummary(period?: string): Promise<PayrollExportRow[]> {
  const runs = await listRuns(period);
  const rows: PayrollExportRow[] = [];
  for (const r of runs) {
    const authorized = r.status === 'APPROVED' || r.status === 'DISBURSED';
    const employee = await db.prepare('SELECT name, bank_name, bank_account_number FROM employees WHERE id = ?').get(r.staff_id) as
      { name: string; bank_name: string | null; bank_account_number: string | null } | undefined;
    rows.push({
      payroll_run_id: r.id, employee_id: r.staff_id, employee_name: r.staff_name ?? employee?.name ?? r.staff_id, period: r.period,
      gross: r.gross, total_deductions: r.total_deductions, net: r.net, status: r.status,
      bank_name: authorized ? employee?.bank_name ?? null : null,
      bank_account_number: authorized ? employee?.bank_account_number ?? null : null,
    });
  }
  return rows;
}

export interface PayrollDeductionScheduleRow { payroll_run_id: string; employee_name: string; period: string; type: DeductionType; description: string | null; amount: number }

/** The "detailed deduction schedule" Section 29 asks for alongside the
 *  summary — one row per individual deduction line, not folded into a
 *  single total. */
export async function exportDeductionSchedule(period?: string): Promise<PayrollDeductionScheduleRow[]> {
  const base = `
    SELECT pd.payroll_run_id, pr.staff_name AS employee_name, pr.period, pd.type, pd.description, pd.amount
    FROM payroll_deductions pd JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
  `;
  const rows = (period ? await db.prepare(`${base} WHERE pr.period = ? ORDER BY pr.staff_name, pd.type`).all(period) : await db.prepare(`${base} ORDER BY pr.staff_name, pd.type`).all()) as unknown as PayrollDeductionScheduleRow[];
  return rows;
}
