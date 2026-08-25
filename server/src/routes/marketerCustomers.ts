import { Router } from 'express';
import * as marketerCustomers from '../services/marketerCustomers.js';
import { safe } from '../lib/errors.js';

export const marketerCustomersRouter = Router();

marketerCustomersRouter.get('/', safe(async (req, res) => {
  const marketerId = typeof req.query.marketerId === 'string' && req.query.marketerId ? req.query.marketerId : undefined;
  res.json(await marketerCustomers.listCustomers(marketerId));
}));

marketerCustomersRouter.post('/', safe(async (req, res) => {
  const { marketerId, name, phone, location, route, creditLimit, actor } = req.body ?? {};
  if (!marketerId || !name) {
    res.status(400).json({ error: 'marketerId and name are required' });
    return;
  }
  res.status(201).json(await marketerCustomers.createCustomer({ marketerId, name, phone, location, route, creditLimit: Number(creditLimit) || 0, actor }));
}));

marketerCustomersRouter.get('/reports/aging', safe(async (_req, res) => {
  res.json(await marketerCustomers.agingReport());
}));

marketerCustomersRouter.get('/reports/dormant', safe(async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(await marketerCustomers.dormantCustomers(days));
}));

marketerCustomersRouter.get('/reports/inactive', safe(async (_req, res) => {
  res.json(await marketerCustomers.inactiveCustomers());
}));

marketerCustomersRouter.get('/reports/credit', safe(async (_req, res) => {
  res.json(await marketerCustomers.creditCustomers());
}));

marketerCustomersRouter.get('/reports/cash', safe(async (_req, res) => {
  res.json(await marketerCustomers.cashCustomers());
}));

marketerCustomersRouter.get('/reports/collections', safe(async (_req, res) => {
  res.json(await marketerCustomers.collectionsReport());
}));

marketerCustomersRouter.get('/reports/credit-transactions', safe(async (_req, res) => {
  res.json(await marketerCustomers.creditTransactions());
}));

marketerCustomersRouter.put('/sales/:saleId/follow-up', safe(async (req, res) => {
  const { dueDate, collector, actor } = req.body ?? {};
  await marketerCustomers.assignFollowUp(req.params.saleId, { dueDate, collector, actor });
  res.json({ ok: true });
}));

marketerCustomersRouter.get('/sales/:saleId/remarks', safe(async (req, res) => {
  res.json(await marketerCustomers.listRemarks(req.params.saleId));
}));

marketerCustomersRouter.post('/sales/:saleId/remarks', safe(async (req, res) => {
  const { remark, actor } = req.body ?? {};
  if (!remark) {
    res.status(400).json({ error: 'remark is required' });
    return;
  }
  await marketerCustomers.addRemark(req.params.saleId, { remark, actor: actor ?? 'System Administrator' });
  res.status(201).json({ ok: true });
}));

marketerCustomersRouter.get('/:id', safe(async (req, res) => {
  const customer = await marketerCustomers.getCustomer(req.params.id);
  if (!customer) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(customer);
}));

marketerCustomersRouter.put('/:id', safe(async (req, res) => {
  const { phone, location, route, creditLimit, status, actor } = req.body ?? {};
  res.json(await marketerCustomers.updateCustomer(req.params.id, {
    phone, location, route, creditLimit: creditLimit != null ? Number(creditLimit) : undefined, status,
  }, actor));
}));

marketerCustomersRouter.get('/:id/balance', safe(async (req, res) => {
  res.json(await marketerCustomers.customerBalance(req.params.id));
}));

marketerCustomersRouter.get('/:id/statement', safe(async (req, res) => {
  res.json(await marketerCustomers.customerStatement(req.params.id));
}));

marketerCustomersRouter.get('/:id/products-purchased', safe(async (req, res) => {
  res.json(await marketerCustomers.productsPurchased(req.params.id));
}));

marketerCustomersRouter.get('/:id/sales', safe(async (req, res) => {
  res.json(await marketerCustomers.listSales(req.params.id));
}));

marketerCustomersRouter.get('/:id/invoices', safe(async (req, res) => {
  res.json(await marketerCustomers.invoiceFollowUps(req.params.id));
}));

marketerCustomersRouter.get('/:id/payments', safe(async (req, res) => {
  res.json(await marketerCustomers.listPayments(req.params.id));
}));

marketerCustomersRouter.post('/:id/sales', safe(async (req, res) => {
  const { marketerId, items, cashReceived, actor } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'marketerId and at least one item are required' });
    return;
  }
  res.status(201).json(await marketerCustomers.recordCustomerSale({
    marketerId, customerId: req.params.id, items, cashReceived: Number(cashReceived) || 0, actor: actor ?? 'System Administrator',
  }));
}));

marketerCustomersRouter.post('/:id/payments', safe(async (req, res) => {
  const { amount, method, actor, referenceId, saleId } = req.body ?? {};
  if (!amount || !method) {
    res.status(400).json({ error: 'amount and method are required' });
    return;
  }
  await marketerCustomers.recordPayment({ customerId: req.params.id, amount: Number(amount), method, actor: actor ?? 'System Administrator', referenceId, saleId });
  res.status(201).json({ ok: true });
}));
