import { Router } from 'express';
import * as finance from '../services/finance.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const financeRouter = Router();

financeRouter.get('/ledger', safe(async (_req, res) => { res.json(await finance.listLedger()); }));
financeRouter.get('/payments', safe(async (req, res) => { res.json(await deletionRequests.filterDeleted('payments', await finance.listPayments(req.query.supplierId as string | undefined))); }));
financeRouter.get('/receipts', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('receipts', await finance.listReceipts())); }));
financeRouter.get('/totals', safe(async (_req, res) => { res.json(await finance.totals()); }));

financeRouter.post('/payments', safe(async (req, res) => {
  const { paidTo, amount, method, referenceType, referenceId, supplierId } = req.body ?? {};
  if (!paidTo || typeof amount !== 'number' || !method) {
    res.status(400).json({ error: 'paidTo, amount and method are required' });
    return;
  }
  res.status(201).json(await finance.recordPayment({ paidTo, amount, method, referenceType, referenceId, supplierId }));
}));

financeRouter.post('/receipts', safe(async (req, res) => {
  const { receivedFrom, amount, method, referenceType, referenceId } = req.body ?? {};
  if (!receivedFrom || typeof amount !== 'number' || !method) {
    res.status(400).json({ error: 'receivedFrom, amount and method are required' });
    return;
  }
  res.status(201).json(await finance.recordReceipt({ receivedFrom, amount, method, referenceType, referenceId }));
}));

financeRouter.post('/payments/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireApproval(userId, 'finance-reverse', ['Finance manager'], 'Finance reversals');
  res.json(await finance.reversePayment(req.params.id, { reason, actor: approver.name }));
}));

financeRouter.post('/receipts/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireApproval(userId, 'finance-reverse', ['Finance manager'], 'Finance reversals');
  res.json(await finance.reverseReceipt(req.params.id, { reason, actor: approver.name }));
}));

// Supplier accounting — every supplier's Accounts payable activity, derived
// live from ledger/payments (see services/finance.ts); nothing new is stored.
financeRouter.get('/payables', safe(async (_req, res) => { res.json(await finance.payablesReport()); }));
financeRouter.get('/aging', safe(async (_req, res) => { res.json(await finance.agingReport()); }));
financeRouter.get('/suppliers/:id/balance', safe(async (req, res) => { res.json(await finance.supplierBalance(req.params.id)); }));
financeRouter.get('/suppliers/:id/statement', safe(async (req, res) => { res.json(await finance.supplierStatement(req.params.id)); }));
financeRouter.get('/suppliers/:id/invoices', safe(async (req, res) => { res.json(await finance.supplierInvoices(req.params.id)); }));

// Customer accounting — the mirror of the supplier routes above, Section 16/17.
financeRouter.get('/receivables', safe(async (_req, res) => { res.json(await finance.receivablesReport()); }));
financeRouter.get('/customer-aging', safe(async (_req, res) => { res.json(await finance.customerAgingReport()); }));
financeRouter.get('/customers/:id/balance', safe(async (req, res) => { res.json(await finance.customerBalance(req.params.id)); }));
financeRouter.get('/customers/:id/statement', safe(async (req, res) => { res.json(await finance.customerStatement(req.params.id)); }));
