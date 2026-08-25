import { Router } from 'express';
import * as retailExchanges from '../services/retailExchanges.js';
import { safe } from '../lib/errors.js';

export const retailExchangesRouter = Router();

retailExchangesRouter.get('/', safe(async (_req, res) => { res.json(await retailExchanges.listExchanges()); }));

retailExchangesRouter.get('/:id', safe(async (req, res) => {
  const ex = await retailExchanges.getExchange(req.params.id);
  if (!ex) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...ex, items: await retailExchanges.listItemsFor(req.params.id) });
}));

retailExchangesRouter.post('/', safe(async (req, res) => {
  const { originalSalesId, returns, reason, staff, actor, newSaleItems, newSalePayments } = req.body ?? {};
  if (!originalSalesId || !Array.isArray(returns) || returns.length === 0 || !reason || !staff) {
    res.status(400).json({ error: 'originalSalesId, at least one return line, reason and staff are required' });
    return;
  }
  res.status(201).json(await retailExchanges.recordExchange({
    originalSalesId, returns, reason, staff, actor: actor ?? staff, newSaleItems, newSalePayments,
  }));
}));
