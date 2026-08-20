import { Router } from 'express';
import * as marketerPerformance from '../services/marketerPerformance.js';

export const marketerPerformanceRouter = Router();

marketerPerformanceRouter.get('/', (req, res) => {
  const { from, to } = req.query;
  const range = typeof from === 'string' && typeof to === 'string' && from && to ? { from, to } : undefined;
  res.json(marketerPerformance.performanceReport(range));
});
