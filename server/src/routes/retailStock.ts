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

// Warehouse dispatches stock to Retail (step 1).
retailStockRouter.post('/dispatch', safe(async (req, res) => {
  const { issuedBy, items } = req.body ?? {};
  if (!issuedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'issuedBy and at least one item are required' });
    return;
  }
  res.status(201).json(await retailStock.dispatchToRetail({ issuedBy, items }));
}));

// Retail reviews and confirms what arrived (step 2).
retailStockRouter.post('/intakes/:id/confirm', safe(async (req, res) => {
  const { confirmedBy, lines } = req.body ?? {};
  if (!confirmedBy) {
    res.status(400).json({ error: 'confirmedBy is required' });
    return;
  }
  res.json(await retailStock.confirmIntake(req.params.id, { confirmedBy, lines: Array.isArray(lines) ? lines : undefined }));
}));

retailStockRouter.get('/daily-report', safe(async (req, res) => { res.json(await retailStock.dailyReport(req.query.date as string | undefined)); }));
