import { Router } from 'express';
import * as supplierReturns from '../services/supplierReturns.js';
import { safe } from '../lib/errors.js';

export const supplierReturnsRouter = Router();

supplierReturnsRouter.get('/', safe(async (_req, res) => { res.json(await supplierReturns.list()); }));

supplierReturnsRouter.get('/:id', safe(async (req, res) => {
  const ret = await supplierReturns.get(req.params.id);
  if (!ret) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...ret, items: await supplierReturns.listItemsFor(req.params.id) });
}));

supplierReturnsRouter.post('/:id/complete', safe(async (req, res) => {
  res.json(await supplierReturns.markCompleted(req.params.id, req.body?.actor));
}));
