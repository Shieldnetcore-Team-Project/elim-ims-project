import { Router } from 'express';
import * as packaging from '../services/packaging.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const finishedGoodsRouter = Router();

finishedGoodsRouter.get('/', (_req, res) => res.json(deletionRequests.filterDeleted('finished_goods', packaging.listFinishedGoods())));

finishedGoodsRouter.post('/', safe((req, res) => {
  const { batchId, itemId, quantity, packagedBy } = req.body ?? {};
  if (!batchId || !itemId || typeof quantity !== 'number' || !packagedBy) {
    res.status(400).json({ error: 'batchId, itemId, quantity and packagedBy are required' });
    return;
  }
  res.status(201).json(packaging.packageBatch({ batchId, itemId, quantity, packagedBy }));
}));

finishedGoodsRouter.post('/:id/reverse', safe((req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = accessControl.requireRole(userId, ['Warehouse Manager']);
  res.json(packaging.reverseFinishedGoods(req.params.id, { reason, actor: approver.name }));
}));
