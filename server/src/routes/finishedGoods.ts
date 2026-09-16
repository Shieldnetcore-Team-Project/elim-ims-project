import { Router } from 'express';
import * as packaging from '../services/packaging.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const finishedGoodsRouter = Router();

finishedGoodsRouter.get('/', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('finished_goods', await packaging.listFinishedGoods())); }));

finishedGoodsRouter.post('/', safe(async (req, res) => {
  const { batchId, itemId, quantity, packagedBy } = req.body ?? {};
  if (!batchId || !itemId || typeof quantity !== 'number' || !packagedBy) {
    res.status(400).json({ error: 'batchId, itemId, quantity and packagedBy are required' });
    return;
  }
  res.status(201).json(await packaging.packageBatch({ batchId, itemId, quantity, packagedBy }));
}));

finishedGoodsRouter.post('/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireApproval(userId, 'warehouse-reverse', ['Warehouse Manager'], 'Warehouse reversals');
  res.json(await packaging.reverseFinishedGoods(req.params.id, { reason, actor: approver.name }));
}));
