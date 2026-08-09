import { Router } from 'express';
import * as retailStock from '../services/retailStock.js';
import { safe } from '../lib/errors.js';

export const retailStockRouter = Router();

retailStockRouter.get('/balances', (_req, res) => res.json(retailStock.getBalances()));

retailStockRouter.get('/intakes', (_req, res) => res.json(retailStock.listIntakes()));

retailStockRouter.get('/intakes/:id', (req, res) => {
  const intake = retailStock.getIntake(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Not found' });
  res.json({ ...intake, items: retailStock.listIntakeItems(req.params.id) });
});

retailStockRouter.post('/intake', safe((req, res) => {
  const { issuedBy, items } = req.body ?? {};
  if (!issuedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'issuedBy and at least one item are required' });
    return;
  }
  res.status(201).json(retailStock.postIntake({ issuedBy, items }));
}));

retailStockRouter.get('/daily-report', (req, res) => res.json(retailStock.dailyReport(req.query.date as string | undefined)));
