import { Router } from 'express';
import * as payroll from '../services/payroll.js';
import { safe } from '../lib/errors.js';

export const payrollRouter = Router();

// Loans
payrollRouter.get('/loans', safe(async (req, res) => { res.json(await payroll.listLoans(req.query.employeeId as string | undefined)); }));
payrollRouter.post('/loans', safe(async (req, res) => {
  const { employeeId, principal, repaymentSchedule, monthlyRepayment, actor } = req.body ?? {};
  if (!employeeId || typeof principal !== 'number' || typeof monthlyRepayment !== 'number' || !actor) {
    res.status(400).json({ error: 'employeeId, principal, monthlyRepayment and actor are required' });
    return;
  }
  res.status(201).json(await payroll.createLoan({ employeeId, principal, repaymentSchedule, monthlyRepayment, actor }));
}));

// Compulsory savings
payrollRouter.get('/savings', safe(async (_req, res) => { res.json(await payroll.listSavings()); }));
payrollRouter.get('/savings/:employeeId', safe(async (req, res) => {
  const savings = await payroll.getSavings(req.params.employeeId);
  if (!savings) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...savings, transactions: await payroll.savingsTransactions(req.params.employeeId) });
}));
payrollRouter.put('/savings/:employeeId', safe(async (req, res) => {
  const { monthlyContribution, startDate, actor } = req.body ?? {};
  if (typeof monthlyContribution !== 'number' || !actor) {
    res.status(400).json({ error: 'monthlyContribution and actor are required' });
    return;
  }
  res.json(await payroll.setSavingsPlan({ employeeId: req.params.employeeId, monthlyContribution, startDate, actor }));
}));
payrollRouter.get('/savings-liquidation-date', safe(async (_req, res) => { res.json({ date: await payroll.liquidationDate() }); }));
payrollRouter.post('/savings/liquidate', safe(async (req, res) => {
  const { authorizedBy, actor } = req.body ?? {};
  if (!authorizedBy) {
    res.status(400).json({ error: 'authorizedBy is required' });
    return;
  }
  res.status(201).json(await payroll.liquidateSavings({ authorizedBy, actor }));
}));

// Payroll runs
payrollRouter.get('/runs', safe(async (req, res) => { res.json(await payroll.listRuns(req.query.period as string | undefined)); }));
payrollRouter.get('/runs/:id', safe(async (req, res) => {
  const run = await payroll.getRun(req.params.id);
  if (!run) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...run, deductions: await payroll.listRunDeductions(req.params.id) });
}));
payrollRouter.post('/runs', safe(async (req, res) => {
  const { staffId, period, gross, manualDeductions, preparedBy, actor } = req.body ?? {};
  if (!staffId || !period || typeof gross !== 'number' || !preparedBy) {
    res.status(400).json({ error: 'staffId, period, gross and preparedBy are required' });
    return;
  }
  res.status(201).json(await payroll.prepareRun({ staffId, period, gross, manualDeductions, preparedBy, actor }));
}));
payrollRouter.post('/runs/:id/review', safe(async (req, res) => {
  const { reviewedBy, actor } = req.body ?? {};
  if (!reviewedBy) { res.status(400).json({ error: 'reviewedBy is required' }); return; }
  res.json(await payroll.reviewRun(req.params.id, { reviewedBy, actor }));
}));
payrollRouter.post('/runs/:id/approve', safe(async (req, res) => {
  const { approvedBy, actor } = req.body ?? {};
  if (!approvedBy) { res.status(400).json({ error: 'approvedBy is required' }); return; }
  res.json(await payroll.approveRun(req.params.id, { approvedBy, actor }));
}));
payrollRouter.post('/runs/:id/reject', safe(async (req, res) => {
  const { reason, actor } = req.body ?? {};
  if (!reason || !actor) { res.status(400).json({ error: 'reason and actor are required' }); return; }
  res.json(await payroll.rejectRun(req.params.id, { reason, actor }));
}));
payrollRouter.post('/runs/:id/disburse', safe(async (req, res) => {
  const { disbursedBy, actor } = req.body ?? {};
  if (!disbursedBy) { res.status(400).json({ error: 'disbursedBy is required' }); return; }
  res.json(await payroll.disburseRun(req.params.id, { disbursedBy, actor }));
}));
payrollRouter.post('/runs/:id/revise', safe(async (req, res) => {
  const { gross, manualDeductions, preparedBy, reason, actor } = req.body ?? {};
  if (typeof gross !== 'number' || !preparedBy || !reason) {
    res.status(400).json({ error: 'gross, preparedBy and reason are required' });
    return;
  }
  res.status(201).json(await payroll.reviseRun(req.params.id, { gross, manualDeductions, preparedBy, reason, actor }));
}));

// Export
payrollRouter.get('/export/summary', safe(async (req, res) => { res.json(await payroll.exportSummary(req.query.period as string | undefined)); }));
payrollRouter.get('/export/deductions', safe(async (req, res) => { res.json(await payroll.exportDeductionSchedule(req.query.period as string | undefined)); }));
