import { Router } from 'express';
import * as finance from '../services/finance.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const financeRouter = Router();

financeRouter.get('/ledger', (_req, res) => res.json(finance.listLedger()));
financeRouter.get('/payments', (_req, res) => res.json(deletionRequests.filterDeleted('payments', finance.listPayments())));
financeRouter.get('/receipts', (_req, res) => res.json(deletionRequests.filterDeleted('receipts', finance.listReceipts())));
financeRouter.get('/totals', (_req, res) => res.json(finance.totals()));

financeRouter.post('/payments', safe((req, res) => {
  const { paidTo, amount, method, referenceType, referenceId } = req.body ?? {};
  if (!paidTo || typeof amount !== 'number' || !method) {
    res.status(400).json({ error: 'paidTo, amount and method are required' });
    return;
  }
  res.status(201).json(finance.recordPayment({ paidTo, amount, method, referenceType, referenceId }));
}));

financeRouter.post('/receipts', safe((req, res) => {
  const { receivedFrom, amount, method, referenceType, referenceId } = req.body ?? {};
  if (!receivedFrom || typeof amount !== 'number' || !method) {
    res.status(400).json({ error: 'receivedFrom, amount and method are required' });
    return;
  }
  res.status(201).json(finance.recordReceipt({ receivedFrom, amount, method, referenceType, referenceId }));
}));
