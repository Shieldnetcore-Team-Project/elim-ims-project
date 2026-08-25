import { Router } from 'express';
import * as dashboard from '../services/dashboard.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const dashboardRouter = Router();

dashboardRouter.get('/kpis', safe(async (_req, res) => { res.json(await dashboard.kpis()); }));
dashboardRouter.get('/trend', safe(async (_req, res) => { res.json(await dashboard.trend()); }));
dashboardRouter.get('/by-product', safe(async (_req, res) => { res.json(await dashboard.byProduct()); }));
dashboardRouter.get('/sales-overview', safe(async (_req, res) => { res.json(await dashboard.salesOverview()); }));

dashboardRouter.get('/profit-loss', safe(async (req, res) => {
  const period = String(req.query.period ?? '7d');
  const days = period === 'qtr' ? 90 : period === '30d' ? 30 : 7;
  res.json(await dashboard.profitLoss(days));
}));

dashboardRouter.get('/low-stock', safe(async (_req, res) => {
  const rows = await deletionRequests.filterDeleted('items', await dashboard.lowStockAlertRows());
  res.json(rows.slice(0, 8));
}));

dashboardRouter.get('/top-products', safe(async (req, res) => {
  const limit = Number(req.query.limit ?? 5);
  res.json(await dashboard.topProducts(limit));
}));

dashboardRouter.get('/stock-status', safe(async (_req, res) => {
  const rows = await deletionRequests.filterDeleted('items', await dashboard.stockStatusRows());
  let inStock = 0, lowStock = 0, outOfStock = 0;
  for (const r of rows) {
    if (r.onHand <= 0) outOfStock++;
    else if (r.onHand <= r.reorderPoint) lowStock++;
    else inStock++;
  }
  res.json({ inStock, lowStock, outOfStock });
}));

dashboardRouter.get('/trace/:deliveryId', safe(async (req, res) => {
  const trace = await dashboard.deliveryTrace(req.params.deliveryId);
  if (!trace) return void res.status(404).json({ error: 'Unrecognised delivery' });
  res.json(trace);
}));
