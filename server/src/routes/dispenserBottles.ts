import { Router } from 'express';
import * as dispenserBottles from '../services/dispenserBottles.js';
import { safe } from '../lib/errors.js';

export const dispenserBottlesRouter = Router();

dispenserBottlesRouter.get('/items', safe((_req, res) => {
  res.json(dispenserBottles.listReturnableItems());
}));

dispenserBottlesRouter.get('/marketer-wise', safe((_req, res) => {
  res.json(dispenserBottles.marketerWiseReport());
}));

dispenserBottlesRouter.get('/customer-wise', safe((_req, res) => {
  res.json(dispenserBottles.customerWiseReport());
}));

dispenserBottlesRouter.get('/movement', safe((req, res) => {
  const bucket = req.query.bucket === 'week' || req.query.bucket === 'month' ? req.query.bucket : 'day';
  const marketerId = typeof req.query.marketerId === 'string' && req.query.marketerId ? req.query.marketerId : undefined;
  res.json(dispenserBottles.movementReport({ bucket, marketerId }));
}));

dispenserBottlesRouter.get('/:marketerId/:itemId/balance', safe((req, res) => {
  res.json(dispenserBottles.custodyBalance(req.params.marketerId, req.params.itemId));
}));

dispenserBottlesRouter.post('/returns', safe((req, res) => {
  const { marketerId, itemId, quantityReturned, soldWithBottle, returnedBy, actor } = req.body ?? {};
  if (!marketerId || !itemId || !returnedBy) {
    res.status(400).json({ error: 'marketerId, itemId and returnedBy are required' });
    return;
  }
  dispenserBottles.recordEmptyReturn({
    marketerId, itemId, quantityReturned: Number(quantityReturned) || 0,
    soldWithBottle: Array.isArray(soldWithBottle) ? soldWithBottle : [], returnedBy, actor,
  });
  res.status(201).json({ ok: true });
}));
