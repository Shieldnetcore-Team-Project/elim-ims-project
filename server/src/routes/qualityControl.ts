import { Router } from 'express';
import * as qualityControl from '../services/qualityControl.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const qualityControlRouter = Router();

qualityControlRouter.get('/pending/goods-received', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('goods_received', await qualityControl.pendingGoodsReceived())); }));
qualityControlRouter.get('/pending/production-batches', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('production_batches', await qualityControl.pendingProductionBatches())); }));
qualityControlRouter.get('/history', safe(async (_req, res) => { res.json(await qualityControl.history()); }));
qualityControlRouter.get('/parameters', safe(async (_req, res) => { res.json(await qualityControl.parameterNames()); }));

qualityControlRouter.get('/:id/detail', safe(async (req, res) => {
  const detail = await qualityControl.getTestDetail(req.params.id);
  if (!detail) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(detail);
}));

qualityControlRouter.post('/', safe(async (req, res) => {
  const { refType, refId, inspector, parameter, result, verdict, notes } = req.body ?? {};
  if (!refType || !refId || !inspector || !verdict) {
    res.status(400).json({ error: 'refType, refId, inspector and verdict are required' });
    return;
  }
  res.status(201).json(await qualityControl.recordResult({ refType, refId, inspector, parameter, result, verdict, notes }));
}));

// The real entry point going forward (Section 19) — one or more named
// parameters per test, verdict derived rather than typed. The single-
// parameter POST / above stays working for any existing caller, unchanged.
qualityControlRouter.post('/tests', safe(async (req, res) => {
  const { refType, refId, inspector, productType, reviewedBy, parameters, notes, actor } = req.body ?? {};
  if (!refType || !refId || !inspector || !Array.isArray(parameters) || parameters.length === 0) {
    res.status(400).json({ error: 'refType, refId, inspector and at least one parameter are required' });
    return;
  }
  res.status(201).json(await qualityControl.recordTest({ refType, refId, inspector, productType, reviewedBy, parameters, notes, actor }));
}));
