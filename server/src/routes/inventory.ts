import { Router } from 'express';
import * as inventory from '../services/inventory.js';
import * as stockPosition from '../services/stockPosition.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const inventoryRouter = Router();

inventoryRouter.get('/balances', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('items', await inventory.getBalances())); }));
inventoryRouter.get('/transactions', safe(async (req, res) => { res.json(await inventory.listTransactions(req.query.itemId as string | undefined)); }));
inventoryRouter.get('/stock-position', safe(async (_req, res) => { res.json(await stockPosition.getStockPosition()); }));

inventoryRouter.post('/adjust', safe(async (req, res) => {
  const { itemId, delta, note } = req.body ?? {};
  if (!itemId || typeof delta !== 'number' || !note) {
    res.status(400).json({ error: 'itemId, delta and note are required' });
    return;
  }
  await inventory.adjustStock(itemId, delta, note, req.body.actor);
  res.status(201).json({ itemId, on_hand: await inventory.getBalance(itemId) });
}));
