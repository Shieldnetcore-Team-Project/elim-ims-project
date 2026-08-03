import { Router } from 'express';
import * as finance from '../services/finance.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const financeRouter = Router();

financeRouter.get('/ledger', (_req, res) => res.json(finance.listLedger()));
financeRouter.get('/payments', (req, res) => res.json(deletionRequests.filterDeleted('payments', finance.listPayments(req.query.supplierId as string | undefined))));
financeRouter.get('/receipts', (_req, res) => res.json(deletionRequests.filterDeleted('receipts', finance.listReceipts())));
financeRouter.get('/totals', (_req, res) => res.json(finance.totals()));

financeRouter.post('/payments', safe((req, res) => {
  const { paidTo, amount, method, referenceType, referenceId, supplierId } = req.body ?? {};
  if (!paidTo || typeof amount !== 'number' || !method) {
    res.status(400).json({ error: 'paidTo, amount and method are required' });
    return;
  }
  res.status(201).json(finance.recordPayment({ paidTo, amount, method, referenceType, referenceId, supplierId }));
}));

financeRouter.post('/receipts', safe((req, res) => {
  const { receivedFrom, amount, method, referenceType, referenceId } = req.body ?? {};
  if (!receivedFrom || typeof amount !== 'number' || !method) {
    res.status(400).json({ error: 'receivedFrom, amount and method are required' });
    return;
  }
  res.status(201).json(finance.recordReceipt({ receivedFrom, amount, method, referenceType, referenceId }));
}));

financeRouter.post('/payments/:id/reverse', safe((req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = accessControl.requireRole(userId, ['Finance manager']);
  res.json(finance.reversePayment(req.params.id, { reason, actor: approver.name }));
}));

financeRouter.post('/receipts/:id/reverse', safe((req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = accessControl.requireRole(userId, ['Finance manager']);
  res.json(finance.reverseReceipt(req.params.id, { reason, actor: approver.name }));
}));

// Supplier accounting — every supplier's Accounts payable activity, derived
// live from ledger/payments (see services/finance.ts); nothing new is stored.
financeRouter.get('/payables', (_req, res) => res.json(finance.payablesReport()));
financeRouter.get('/aging', (_req, res) => res.json(finance.agingReport()));
financeRouter.get('/suppliers/:id/balance', (req, res) => res.json(finance.supplierBalance(req.params.id)));
financeRouter.get('/suppliers/:id/statement', (req, res) => res.json(finance.supplierStatement(req.params.id)));
