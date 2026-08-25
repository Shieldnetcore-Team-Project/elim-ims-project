import { Router } from 'express';
import * as retailStock from '../services/retailStock.js';
import { safe } from '../lib/errors.js';

export const retailStockRouter = Router();

retailStockRouter.get('/balances', safe(async (_req, res) => { res.json(await retailStock.getBalances()); }));

retailStockRouter.get('/intakes', safe(async (_req, res) => { res.json(await retailStock.listIntakes()); }));

retailStockRouter.get('/intakes/:id', safe(async (req, res) => {
  const intake = await retailStock.getIntake(req.params.id);
  if (!intake) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...intake, items: await retailStock.listIntakeItems(req.params.id) });
}));

retailStockRouter.post('/intake', safe(async (req, res) => {
  const { issuedBy, items } = req.body ?? {};
  if (!issuedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'issuedBy and at least one item are required' });
    return;
  }
  res.status(201).json(await retailStock.postIntake({ issuedBy, items }));
}));

retailStockRouter.get('/daily-report', safe(async (req, res) => { res.json(await retailStock.dailyReport(req.query.date as string | undefined)); }));
