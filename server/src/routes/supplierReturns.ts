import { Router } from 'express';
import * as supplierReturns from '../services/supplierReturns.js';
import { safe } from '../lib/errors.js';

export const supplierReturnsRouter = Router();

supplierReturnsRouter.get('/', (_req, res) => res.json(supplierReturns.list()));

supplierReturnsRouter.get('/:id', (req, res) => {
  const ret = supplierReturns.get(req.params.id);
  if (!ret) return res.status(404).json({ error: 'Not found' });
  res.json({ ...ret, items: supplierReturns.listItemsFor(req.params.id) });
});

supplierReturnsRouter.post('/:id/complete', safe((req, res) => {
  res.json(supplierReturns.markCompleted(req.params.id, req.body?.actor));
}));
