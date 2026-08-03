import { Router } from 'express';
import * as salesReturns from '../services/salesReturns.js';
import { safe } from '../lib/errors.js';

export const salesReturnsRouter = Router();

salesReturnsRouter.get('/', (_req, res) => res.json(salesReturns.list()));
salesReturnsRouter.get('/pending-inspection', (_req, res) => res.json(salesReturns.pendingInspection()));

salesReturnsRouter.get('/:id', (req, res) => {
  const ret = salesReturns.getReturn(req.params.id);
  if (!ret) return res.status(404).json({ error: 'Not found' });
  res.json({ ...ret, items: salesReturns.listItemsFor(req.params.id) });
});

salesReturnsRouter.post('/', safe((req, res) => {
  const { salesId, items, actor } = req.body ?? {};
  if (!salesId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'salesId and at least one item are required' });
    return;
  }
  res.status(201).json(salesReturns.createReturn({ salesId, items, actor: actor ?? 'System Administrator' }));
}));

salesReturnsRouter.post('/:id/inspect', safe((req, res) => {
  const { inspectorOfficer, lines, actor } = req.body ?? {};
  if (!inspectorOfficer || !Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: 'inspectorOfficer and at least one line are required' });
    return;
  }
  res.json(salesReturns.inspectReturn(req.params.id, { inspectorOfficer, lines, actor }));
}));
