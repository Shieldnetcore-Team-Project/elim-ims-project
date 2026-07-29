import { Router } from 'express';
import * as qualityControl from '../services/qualityControl.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const qualityControlRouter = Router();

qualityControlRouter.get('/pending/goods-received', (_req, res) => res.json(deletionRequests.filterDeleted('goods_received', qualityControl.pendingGoodsReceived())));
qualityControlRouter.get('/pending/production-batches', (_req, res) => res.json(deletionRequests.filterDeleted('production_batches', qualityControl.pendingProductionBatches())));
qualityControlRouter.get('/history', (_req, res) => res.json(qualityControl.history()));

qualityControlRouter.post('/', safe((req, res) => {
  const { refType, refId, inspector, parameter, result, verdict, notes } = req.body ?? {};
  if (!refType || !refId || !inspector || !verdict) {
    res.status(400).json({ error: 'refType, refId, inspector and verdict are required' });
    return;
  }
  res.status(201).json(qualityControl.recordResult({ refType, refId, inspector, parameter, result, verdict, notes }));
}));
