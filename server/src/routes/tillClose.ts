import { Router } from 'express';
import * as tillClose from '../services/tillClose.js';
import { safe } from '../lib/errors.js';

export const tillCloseRouter = Router();

tillCloseRouter.get('/', safe(async (_req, res) => { res.json(await tillClose.listTillCloses()); }));
tillCloseRouter.get('/today-figures', safe(async (req, res) => { res.json(await tillClose.todayCashFigures(req.query.businessDate as string | undefined)); }));
tillCloseRouter.get('/is-closed', safe(async (req, res) => { res.json({ closed: await tillClose.isTillClosed(req.query.till as string | undefined, req.query.businessDate as string | undefined) }); }));

tillCloseRouter.post('/', safe(async (req, res) => {
  const { till, businessDate, openingBalance, payments, adjustments, actualClosing, closedBy, actor } = req.body ?? {};
  if (typeof openingBalance !== 'number' || typeof actualClosing !== 'number' || !closedBy) {
    res.status(400).json({ error: 'openingBalance, actualClosing and closedBy are required' });
    return;
  }
  res.status(201).json(await tillClose.closeTill({
    till, businessDate, openingBalance, payments: Number(payments) || 0, adjustments: Number(adjustments) || 0, actualClosing, closedBy, actor,
  }));
}));

tillCloseRouter.post('/:id/review', safe(async (req, res) => {
  const { reviewedBy, actor } = req.body ?? {};
  if (!reviewedBy) {
    res.status(400).json({ error: 'reviewedBy is required' });
    return;
  }
  res.json(await tillClose.reviewTill(req.params.id, { reviewedBy, actor }));
}));
