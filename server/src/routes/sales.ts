import { Router } from 'express';
import * as sales from '../services/sales.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const salesRouter = Router();

salesRouter.get('/', (req, res) => res.json(deletionRequests.filterDeleted('sales', sales.listOrders(req.query.channel as 'INVOICE' | 'POS' | undefined))));

salesRouter.get('/:id', (req, res) => {
  const order = sales.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ ...order, items: sales.listItemsFor(req.params.id) });
});

salesRouter.post('/', safe((req, res) => {
  const { customerId, channel, rep, items } = req.body ?? {};
  if (!customerId || !channel || !rep || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'customerId, channel, rep and at least one item are required' });
    return;
  }
  res.status(201).json(sales.createOrder({ customerId, channel, rep, items }));
}));
