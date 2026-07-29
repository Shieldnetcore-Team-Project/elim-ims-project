import { Router } from 'express';
import * as receiving from '../services/receiving.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const goodsReceivedRouter = Router();

goodsReceivedRouter.get('/', (_req, res) => res.json(deletionRequests.filterDeleted('goods_received', receiving.listGoodsReceived())));
goodsReceivedRouter.get('/pending-qc', (_req, res) => res.json(deletionRequests.filterDeleted('goods_received', receiving.pendingQc())));

goodsReceivedRouter.get('/:id', (req, res) => {
  const grn = receiving.getGoodsReceived(req.params.id);
  if (!grn) return res.status(404).json({ error: 'Not found' });
  res.json({ ...grn, items: receiving.listItemsFor(req.params.id) });
});

goodsReceivedRouter.post('/', safe((req, res) => {
  const { poId, receivedBy, items } = req.body ?? {};
  if (!poId || !receivedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'poId, receivedBy and at least one item are required' });
    return;
  }
  res.status(201).json(receiving.receiveGoods({ poId, receivedBy, items }));
}));
