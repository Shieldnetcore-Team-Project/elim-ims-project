import { Router } from 'express';
import * as dispenserBottles from '../services/dispenserBottles.js';
import { safe } from '../lib/errors.js';

export const dispenserBottlesRouter = Router();

dispenserBottlesRouter.get('/items', safe(async (_req, res) => {
  res.json(await dispenserBottles.listReturnableItems());
}));

dispenserBottlesRouter.get('/marketer-wise', safe(async (_req, res) => {
  res.json(await dispenserBottles.marketerWiseReport());
}));

dispenserBottlesRouter.get('/customer-wise', safe(async (_req, res) => {
  res.json(await dispenserBottles.customerWiseReport());
}));

dispenserBottlesRouter.get('/movement', safe(async (req, res) => {
  const bucket = req.query.bucket === 'week' || req.query.bucket === 'month' ? req.query.bucket : 'day';
  const marketerId = typeof req.query.marketerId === 'string' && req.query.marketerId ? req.query.marketerId : undefined;
  res.json(await dispenserBottles.movementReport({ bucket, marketerId }));
}));

dispenserBottlesRouter.get('/:marketerId/:itemId/balance', safe(async (req, res) => {
  res.json(await dispenserBottles.custodyBalance(req.params.marketerId, req.params.itemId));
}));

dispenserBottlesRouter.post('/returns', safe(async (req, res) => {
  const { marketerId, itemId, quantityReturned, soldWithBottle, returnedBy, actor } = req.body ?? {};
  if (!marketerId || !itemId || !returnedBy) {
    res.status(400).json({ error: 'marketerId, itemId and returnedBy are required' });
    return;
  }
  await dispenserBottles.recordEmptyReturn({
    marketerId, itemId, quantityReturned: Number(quantityReturned) || 0,
    soldWithBottle: Array.isArray(soldWithBottle) ? soldWithBottle : [], returnedBy, actor,
  });
  res.status(201).json({ ok: true });
}));
