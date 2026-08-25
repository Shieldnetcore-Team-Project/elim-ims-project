import { Router } from 'express';
import * as driverPerformance from '../services/driverPerformance.js';
import { safe } from '../lib/errors.js';

export const driverPerformanceRouter = Router();

driverPerformanceRouter.get('/', safe(async (req, res) => { res.json(await driverPerformance.report(req.query.period as string | undefined)); }));
