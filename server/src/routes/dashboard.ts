import { Router } from 'express';
import * as dashboard from '../services/dashboard.js';
import * as deletionRequests from '../services/deletionRequests.js';

export const dashboardRouter = Router();

dashboardRouter.get('/kpis', (_req, res) => res.json(dashboard.kpis()));
dashboardRouter.get('/trend', (_req, res) => res.json(dashboard.trend()));
dashboardRouter.get('/by-product', (_req, res) => res.json(dashboard.byProduct()));
dashboardRouter.get('/sales-overview', (_req, res) => res.json(dashboard.salesOverview()));

dashboardRouter.get('/profit-loss', (req, res) => {
  const period = String(req.query.period ?? '7d');
  const days = period === 'qtr' ? 90 : period === '30d' ? 30 : 7;
  res.json(dashboard.profitLoss(days));
});

dashboardRouter.get('/low-stock', (_req, res) => {
  const rows = deletionRequests.filterDeleted('items', dashboard.lowStockAlertRows());
  res.json(rows.slice(0, 8));
});

dashboardRouter.get('/top-products', (req, res) => {
  const limit = Number(req.query.limit ?? 5);
  res.json(dashboard.topProducts(limit));
});

dashboardRouter.get('/stock-status', (_req, res) => {
  const rows = deletionRequests.filterDeleted('items', dashboard.stockStatusRows());
  let inStock = 0, lowStock = 0, outOfStock = 0;
  for (const r of rows) {
    if (r.onHand <= 0) outOfStock++;
    else if (r.onHand <= r.reorderPoint) lowStock++;
    else inStock++;
  }
  res.json({ inStock, lowStock, outOfStock });
});

dashboardRouter.get('/trace/:deliveryId', (req, res) => {
  const trace = dashboard.deliveryTrace(req.params.deliveryId);
  if (!trace) return res.status(404).json({ error: 'Unrecognised delivery' });
  res.json(trace);
});
