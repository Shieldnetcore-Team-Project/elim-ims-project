import { Router } from 'express';
import * as sales from '../services/sales.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const salesRouter = Router();

salesRouter.get('/', safe(async (req, res) => { res.json(await deletionRequests.filterDeleted('sales', await sales.listOrders(req.query.channel as 'INVOICE' | 'POS' | undefined))); }));

salesRouter.get('/pending-credit-approval', safe(async (_req, res) => { res.json(await sales.pendingCreditApproval()); }));

salesRouter.get('/retail-customers', safe(async (_req, res) => { res.json(await sales.retailCustomerActivity()); }));

salesRouter.get('/reps', safe(async (_req, res) => { res.json(await sales.listReps()); }));

salesRouter.get('/next-invoice-no', safe(async (_req, res) => { res.json({ invoiceNumber: await sales.nextInvoiceNumber() }); }));

salesRouter.get('/:id', safe(async (req, res) => {
  const order = await sales.getOrder(req.params.id);
  if (!order) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...order, items: await sales.listItemsFor(req.params.id) });
}));

salesRouter.post('/', safe(async (req, res) => {
  const { customerId, channel, rep, paymentTerms, items, branchId, manualInvoiceNumber, walkInName, payments } = req.body ?? {};
  if (!channel || !rep || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'channel, rep and at least one item are required' });
    return;
  }
  res.status(201).json(await sales.createOrder({ customerId, channel, rep, paymentTerms, items, branchId, manualInvoiceNumber, walkInName, payments }));
}));

// Requires the separate "sales-approve" capability, distinct from ordinary
// sales page access, so the rep who raised the credit order can't also
// approve their own.
salesRouter.post('/:id/approve-credit', safe(async (req, res) => {
  await accessControl.requirePageAccess(req.body?.userId, 'sales-approve', 'Sales approvals');
  res.json(await sales.approveCreditSale(req.params.id, req.body?.actor));
}));

salesRouter.post('/:id/reject-credit', safe(async (req, res) => {
  await accessControl.requirePageAccess(req.body?.userId, 'sales-approve', 'Sales approvals');
  res.json(await sales.rejectCreditSale(req.params.id, req.body?.actor));
}));

salesRouter.post('/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireApproval(userId, 'sales-reverse', ['Sales manager'], 'Sales reversals');
  res.json(await sales.reverseOrder(req.params.id, { reason, actor: approver.name }));
}));
