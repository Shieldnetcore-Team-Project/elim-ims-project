import { Router } from 'express';
import * as marketerPerformance from '../services/marketerPerformance.js';
import { safe } from '../lib/errors.js';

export const marketerPerformanceRouter = Router();

marketerPerformanceRouter.get('/', safe(async (req, res) => {
  const { from, to } = req.query;
  const range = typeof from === 'string' && typeof to === 'string' && from && to ? { from, to } : undefined;
  res.json(await marketerPerformance.performanceReport(range));
}));
