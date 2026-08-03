import { Router } from 'express';
import * as marketerCustomers from '../services/marketerCustomers.js';
import { safe } from '../lib/errors.js';

export const marketerCustomersRouter = Router();

marketerCustomersRouter.get('/', safe((req, res) => {
  const marketerId = typeof req.query.marketerId === 'string' && req.query.marketerId ? req.query.marketerId : undefined;
  res.json(marketerCustomers.listCustomers(marketerId));
}));

marketerCustomersRouter.post('/', safe((req, res) => {
  const { marketerId, name, phone, location, route, creditLimit, actor } = req.body ?? {};
  if (!marketerId || !name) {
    res.status(400).json({ error: 'marketerId and name are required' });
    return;
  }
  res.status(201).json(marketerCustomers.createCustomer({ marketerId, name, phone, location, route, creditLimit: Number(creditLimit) || 0, actor }));
}));

marketerCustomersRouter.get('/reports/aging', safe((_req, res) => {
  res.json(marketerCustomers.agingReport());
}));

marketerCustomersRouter.get('/reports/dormant', safe((req, res) => {
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(marketerCustomers.dormantCustomers(days));
}));

marketerCustomersRouter.get('/reports/inactive', safe((_req, res) => {
  res.json(marketerCustomers.inactiveCustomers());
}));

marketerCustomersRouter.get('/reports/credit', safe((_req, res) => {
  res.json(marketerCustomers.creditCustomers());
}));

marketerCustomersRouter.get('/reports/cash', safe((_req, res) => {
  res.json(marketerCustomers.cashCustomers());
}));

marketerCustomersRouter.get('/reports/collections', safe((_req, res) => {
  res.json(marketerCustomers.collectionsReport());
}));

marketerCustomersRouter.put('/sales/:saleId/follow-up', safe((req, res) => {
  const { dueDate, collector, actor } = req.body ?? {};
  marketerCustomers.assignFollowUp(req.params.saleId, { dueDate, collector, actor });
  res.json({ ok: true });
}));

marketerCustomersRouter.get('/sales/:saleId/remarks', safe((req, res) => {
  res.json(marketerCustomers.listRemarks(req.params.saleId));
}));

marketerCustomersRouter.post('/sales/:saleId/remarks', safe((req, res) => {
  const { remark, actor } = req.body ?? {};
  if (!remark) {
    res.status(400).json({ error: 'remark is required' });
    return;
  }
  marketerCustomers.addRemark(req.params.saleId, { remark, actor: actor ?? 'System Administrator' });
  res.status(201).json({ ok: true });
}));

marketerCustomersRouter.get('/:id', safe((req, res) => {
  const customer = marketerCustomers.getCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  res.json(customer);
}));

marketerCustomersRouter.put('/:id', safe((req, res) => {
  const { phone, location, route, creditLimit, status, actor } = req.body ?? {};
  res.json(marketerCustomers.updateCustomer(req.params.id, {
    phone, location, route, creditLimit: creditLimit != null ? Number(creditLimit) : undefined, status,
  }, actor));
}));

marketerCustomersRouter.get('/:id/balance', safe((req, res) => {
  res.json(marketerCustomers.customerBalance(req.params.id));
}));

marketerCustomersRouter.get('/:id/statement', safe((req, res) => {
  res.json(marketerCustomers.customerStatement(req.params.id));
}));

marketerCustomersRouter.get('/:id/products-purchased', safe((req, res) => {
  res.json(marketerCustomers.productsPurchased(req.params.id));
}));

marketerCustomersRouter.get('/:id/sales', safe((req, res) => {
  res.json(marketerCustomers.listSales(req.params.id));
}));

marketerCustomersRouter.get('/:id/invoices', safe((req, res) => {
  res.json(marketerCustomers.invoiceFollowUps(req.params.id));
}));

marketerCustomersRouter.get('/:id/payments', safe((req, res) => {
  res.json(marketerCustomers.listPayments(req.params.id));
}));

marketerCustomersRouter.post('/:id/sales', safe((req, res) => {
  const { marketerId, items, cashReceived, actor } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'marketerId and at least one item are required' });
    return;
  }
  res.status(201).json(marketerCustomers.recordCustomerSale({
    marketerId, customerId: req.params.id, items, cashReceived: Number(cashReceived) || 0, actor: actor ?? 'System Administrator',
  }));
}));

marketerCustomersRouter.post('/:id/payments', safe((req, res) => {
  const { amount, method, actor, referenceId, saleId } = req.body ?? {};
  if (!amount || !method) {
    res.status(400).json({ error: 'amount and method are required' });
    return;
  }
  marketerCustomers.recordPayment({ customerId: req.params.id, amount: Number(amount), method, actor: actor ?? 'System Administrator', referenceId, saleId });
  res.status(201).json({ ok: true });
}));
