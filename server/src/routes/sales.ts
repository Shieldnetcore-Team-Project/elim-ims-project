import { Router } from 'express';
import * as sales from '../services/sales.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const salesRouter = Router();

salesRouter.get('/', (req, res) => res.json(deletionRequests.filterDeleted('sales', sales.listOrders(req.query.channel as 'INVOICE' | 'POS' | undefined))));

salesRouter.get('/pending-credit-approval', (_req, res) => res.json(sales.pendingCreditApproval()));

salesRouter.get('/:id', (req, res) => {
  const order = sales.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ ...order, items: sales.listItemsFor(req.params.id) });
});

salesRouter.post('/', safe((req, res) => {
  const { customerId, channel, rep, paymentTerms, items, branchId, manualInvoiceNumber, payments } = req.body ?? {};
  if (!channel || !rep || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'channel, rep and at least one item are required' });
    return;
  }
  res.status(201).json(sales.createOrder({ customerId, channel, rep, paymentTerms, items, branchId, manualInvoiceNumber, payments }));
}));

// Requires the separate "sales-approve" capability, distinct from ordinary
// sales page access, so the rep who raised the credit order can't also
// approve their own.
salesRouter.post('/:id/approve-credit', safe((req, res) => {
  accessControl.requirePageAccess(req.body?.userId, 'sales-approve', 'Sales approvals');
  res.json(sales.approveCreditSale(req.params.id, req.body?.actor));
}));

salesRouter.post('/:id/reject-credit', safe((req, res) => {
  accessControl.requirePageAccess(req.body?.userId, 'sales-approve', 'Sales approvals');
  res.json(sales.rejectCreditSale(req.params.id, req.body?.actor));
}));

salesRouter.post('/:id/reverse', safe((req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = accessControl.requireRole(userId, ['Sales manager']);
  res.json(sales.reverseOrder(req.params.id, { reason, actor: approver.name }));
}));
