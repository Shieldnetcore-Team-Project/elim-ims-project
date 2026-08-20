import { Router } from 'express';
import * as inventory from '../services/inventory.js';
import * as stockPosition from '../services/stockPosition.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const inventoryRouter = Router();

inventoryRouter.get('/balances', (_req, res) => res.json(deletionRequests.filterDeleted('items', inventory.getBalances())));
inventoryRouter.get('/transactions', (req, res) => res.json(inventory.listTransactions(req.query.itemId as string | undefined)));
inventoryRouter.get('/stock-position', (_req, res) => res.json(stockPosition.getStockPosition()));

inventoryRouter.post('/adjust', safe((req, res) => {
  const { itemId, delta, note } = req.body ?? {};
  if (!itemId || typeof delta !== 'number' || !note) {
    res.status(400).json({ error: 'itemId, delta and note are required' });
    return;
  }
  inventory.adjustStock(itemId, delta, note, req.body.actor);
  res.status(201).json({ itemId, on_hand: inventory.getBalance(itemId) });
}));
