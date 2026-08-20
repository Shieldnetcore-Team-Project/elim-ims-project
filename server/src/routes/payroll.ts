import { Router } from 'express';
import * as payroll from '../services/payroll.js';
import { safe } from '../lib/errors.js';

export const payrollRouter = Router();

// Loans
payrollRouter.get('/loans', safe((req, res) => res.json(payroll.listLoans(req.query.employeeId as string | undefined))));
payrollRouter.post('/loans', safe((req, res) => {
  const { employeeId, principal, repaymentSchedule, monthlyRepayment, actor } = req.body ?? {};
  if (!employeeId || typeof principal !== 'number' || typeof monthlyRepayment !== 'number' || !actor) {
    res.status(400).json({ error: 'employeeId, principal, monthlyRepayment and actor are required' });
    return;
  }
  res.status(201).json(payroll.createLoan({ employeeId, principal, repaymentSchedule, monthlyRepayment, actor }));
}));

// Compulsory savings
payrollRouter.get('/savings', safe((_req, res) => res.json(payroll.listSavings())));
payrollRouter.get('/savings/:employeeId', safe((req, res) => {
  const savings = payroll.getSavings(req.params.employeeId);
  if (!savings) return res.status(404).json({ error: 'Not found' });
  res.json({ ...savings, transactions: payroll.savingsTransactions(req.params.employeeId) });
}));
payrollRouter.put('/savings/:employeeId', safe((req, res) => {
  const { monthlyContribution, startDate, actor } = req.body ?? {};
  if (typeof monthlyContribution !== 'number' || !actor) {
    res.status(400).json({ error: 'monthlyContribution and actor are required' });
    return;
  }
  res.json(payroll.setSavingsPlan({ employeeId: req.params.employeeId, monthlyContribution, startDate, actor }));
}));
payrollRouter.get('/savings-liquidation-date', (_req, res) => res.json({ date: payroll.liquidationDate() }));
payrollRouter.post('/savings/liquidate', safe((req, res) => {
  const { authorizedBy, actor } = req.body ?? {};
  if (!authorizedBy) {
    res.status(400).json({ error: 'authorizedBy is required' });
    return;
  }
  res.status(201).json(payroll.liquidateSavings({ authorizedBy, actor }));
}));

// Payroll runs
payrollRouter.get('/runs', (req, res) => res.json(payroll.listRuns(req.query.period as string | undefined)));
payrollRouter.get('/runs/:id', (req, res) => {
  const run = payroll.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json({ ...run, deductions: payroll.listRunDeductions(req.params.id) });
});
payrollRouter.post('/runs', safe((req, res) => {
  const { staffId, period, gross, manualDeductions, preparedBy, actor } = req.body ?? {};
  if (!staffId || !period || typeof gross !== 'number' || !preparedBy) {
    res.status(400).json({ error: 'staffId, period, gross and preparedBy are required' });
    return;
  }
  res.status(201).json(payroll.prepareRun({ staffId, period, gross, manualDeductions, preparedBy, actor }));
}));
payrollRouter.post('/runs/:id/review', safe((req, res) => {
  const { reviewedBy, actor } = req.body ?? {};
  if (!reviewedBy) { res.status(400).json({ error: 'reviewedBy is required' }); return; }
  res.json(payroll.reviewRun(req.params.id, { reviewedBy, actor }));
}));
payrollRouter.post('/runs/:id/approve', safe((req, res) => {
  const { approvedBy, actor } = req.body ?? {};
  if (!approvedBy) { res.status(400).json({ error: 'approvedBy is required' }); return; }
  res.json(payroll.approveRun(req.params.id, { approvedBy, actor }));
}));
payrollRouter.post('/runs/:id/reject', safe((req, res) => {
  const { reason, actor } = req.body ?? {};
  if (!reason || !actor) { res.status(400).json({ error: 'reason and actor are required' }); return; }
  res.json(payroll.rejectRun(req.params.id, { reason, actor }));
}));
payrollRouter.post('/runs/:id/disburse', safe((req, res) => {
  const { disbursedBy, actor } = req.body ?? {};
  if (!disbursedBy) { res.status(400).json({ error: 'disbursedBy is required' }); return; }
  res.json(payroll.disburseRun(req.params.id, { disbursedBy, actor }));
}));
payrollRouter.post('/runs/:id/revise', safe((req, res) => {
  const { gross, manualDeductions, preparedBy, reason, actor } = req.body ?? {};
  if (typeof gross !== 'number' || !preparedBy || !reason) {
    res.status(400).json({ error: 'gross, preparedBy and reason are required' });
    return;
  }
  res.status(201).json(payroll.reviseRun(req.params.id, { gross, manualDeductions, preparedBy, reason, actor }));
}));

// Export
payrollRouter.get('/export/summary', (req, res) => res.json(payroll.exportSummary(req.query.period as string | undefined)));
payrollRouter.get('/export/deductions', (req, res) => res.json(payroll.exportDeductionSchedule(req.query.period as string | undefined)));
