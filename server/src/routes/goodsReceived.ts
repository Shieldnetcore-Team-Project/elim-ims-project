import { Router } from 'express';
import * as receiving from '../services/receiving.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const goodsReceivedRouter = Router();

goodsReceivedRouter.get('/', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('goods_received', await receiving.listGoodsReceived())); }));
goodsReceivedRouter.get('/pending-qc', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('goods_received', await receiving.pendingQc())); }));

goodsReceivedRouter.get('/:id', safe(async (req, res) => {
  const grn = await receiving.getGoodsReceived(req.params.id);
  if (!grn) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...grn, items: await receiving.listItemsFor(req.params.id) });
}));

goodsReceivedRouter.post('/', safe(async (req, res) => {
  const { poId, receivedBy, items, driverName, driverPhone, vehicleNumber, deliveryDate, invoiceNumber, waybillNumber } = req.body ?? {};
  if (!poId || !receivedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'poId, receivedBy and at least one item are required' });
    return;
  }
  res.status(201).json(await receiving.receiveGoods({
    poId, receivedBy, items, driverName, driverPhone, vehicleNumber, deliveryDate, invoiceNumber, waybillNumber,
  }));
}));

goodsReceivedRouter.post('/:id/inspect', safe(async (req, res) => {
  const { inspectionOfficer, lines, actor } = req.body ?? {};
  if (!inspectionOfficer || !Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: 'inspectionOfficer and at least one line are required' });
    return;
  }
  res.json(await receiving.inspectGoodsReceived(req.params.id, { inspectionOfficer, lines, actor }));
}));

goodsReceivedRouter.post('/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireApproval(userId, 'warehouse-reverse', ['Warehouse Manager'], 'Warehouse reversals');
  res.json(await receiving.reverseGoodsReceived(req.params.id, { reason, actor: approver.name }));
}));
