import { Router } from 'express';
import * as salesReturns from '../services/salesReturns.js';
import { safe } from '../lib/errors.js';

export const salesReturnsRouter = Router();

salesReturnsRouter.get('/', safe(async (_req, res) => { res.json(await salesReturns.list()); }));
salesReturnsRouter.get('/pending-inspection', safe(async (_req, res) => { res.json(await salesReturns.pendingInspection()); }));

salesReturnsRouter.get('/:id', safe(async (req, res) => {
  const ret = await salesReturns.getReturn(req.params.id);
  if (!ret) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...ret, items: await salesReturns.listItemsFor(req.params.id) });
}));

salesReturnsRouter.post('/', safe(async (req, res) => {
  const { salesId, items, actor } = req.body ?? {};
  if (!salesId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'salesId and at least one item are required' });
    return;
  }
  res.status(201).json(await salesReturns.createReturn({ salesId, items, actor: actor ?? 'System Administrator' }));
}));

salesReturnsRouter.post('/:id/inspect', safe(async (req, res) => {
  const { inspectorOfficer, lines, actor } = req.body ?? {};
  if (!inspectorOfficer || !Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: 'inspectorOfficer and at least one line are required' });
    return;
  }
  res.json(await salesReturns.inspectReturn(req.params.id, { inspectorOfficer, lines, actor }));
}));
