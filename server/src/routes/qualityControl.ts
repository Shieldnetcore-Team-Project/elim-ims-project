import { Router } from 'express';
import * as qualityControl from '../services/qualityControl.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const qualityControlRouter = Router();

qualityControlRouter.get('/pending/goods-received', (_req, res) => res.json(deletionRequests.filterDeleted('goods_received', qualityControl.pendingGoodsReceived())));
qualityControlRouter.get('/pending/production-batches', (_req, res) => res.json(deletionRequests.filterDeleted('production_batches', qualityControl.pendingProductionBatches())));
qualityControlRouter.get('/history', (_req, res) => res.json(qualityControl.history()));
qualityControlRouter.get('/parameters', (_req, res) => res.json(qualityControl.parameterNames()));

qualityControlRouter.get('/:id/detail', (req, res) => {
  const detail = qualityControl.getTestDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Not found' });
  res.json(detail);
});

qualityControlRouter.post('/', safe((req, res) => {
  const { refType, refId, inspector, parameter, result, verdict, notes } = req.body ?? {};
  if (!refType || !refId || !inspector || !verdict) {
    res.status(400).json({ error: 'refType, refId, inspector and verdict are required' });
    return;
  }
  res.status(201).json(qualityControl.recordResult({ refType, refId, inspector, parameter, result, verdict, notes }));
}));

// The real entry point going forward (Section 19) — one or more named
// parameters per test, verdict derived rather than typed. The single-
// parameter POST / above stays working for any existing caller, unchanged.
qualityControlRouter.post('/tests', safe((req, res) => {
  const { refType, refId, inspector, productType, reviewedBy, parameters, notes, actor } = req.body ?? {};
  if (!refType || !refId || !inspector || !Array.isArray(parameters) || parameters.length === 0) {
    res.status(400).json({ error: 'refType, refId, inspector and at least one parameter are required' });
    return;
  }
  res.status(201).json(qualityControl.recordTest({ refType, refId, inspector, productType, reviewedBy, parameters, notes, actor }));
}));
