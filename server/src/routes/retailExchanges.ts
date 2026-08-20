import { Router } from 'express';
import * as retailExchanges from '../services/retailExchanges.js';
import { safe } from '../lib/errors.js';

export const retailExchangesRouter = Router();

retailExchangesRouter.get('/', (_req, res) => res.json(retailExchanges.listExchanges()));

retailExchangesRouter.get('/:id', (req, res) => {
  const ex = retailExchanges.getExchange(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  res.json({ ...ex, items: retailExchanges.listItemsFor(req.params.id) });
});

retailExchangesRouter.post('/', safe((req, res) => {
  const { originalSalesId, returns, reason, staff, actor, newSaleItems, newSalePayments } = req.body ?? {};
  if (!originalSalesId || !Array.isArray(returns) || returns.length === 0 || !reason || !staff) {
    res.status(400).json({ error: 'originalSalesId, at least one return line, reason and staff are required' });
    return;
  }
  res.status(201).json(retailExchanges.recordExchange({
    originalSalesId, returns, reason, staff, actor: actor ?? staff, newSaleItems, newSalePayments,
  }));
}));
