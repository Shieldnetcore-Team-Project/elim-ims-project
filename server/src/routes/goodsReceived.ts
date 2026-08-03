import { Router } from 'express';
import * as receiving from '../services/receiving.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
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
  const { poId, receivedBy, items, driverName, driverPhone, vehicleNumber, deliveryDate, invoiceNumber, waybillNumber } = req.body ?? {};
  if (!poId || !receivedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'poId, receivedBy and at least one item are required' });
    return;
  }
  res.status(201).json(receiving.receiveGoods({
    poId, receivedBy, items, driverName, driverPhone, vehicleNumber, deliveryDate, invoiceNumber, waybillNumber,
  }));
}));

goodsReceivedRouter.post('/:id/inspect', safe((req, res) => {
  const { inspectionOfficer, lines, actor } = req.body ?? {};
  if (!inspectionOfficer || !Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: 'inspectionOfficer and at least one line are required' });
    return;
  }
  res.json(receiving.inspectGoodsReceived(req.params.id, { inspectionOfficer, lines, actor }));
}));

goodsReceivedRouter.post('/:id/reverse', safe((req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = accessControl.requireRole(userId, ['Warehouse Manager']);
  res.json(receiving.reverseGoodsReceived(req.params.id, { reason, actor: approver.name }));
}));
