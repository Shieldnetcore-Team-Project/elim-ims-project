import { Router } from 'express';
import * as driverPerformance from '../services/driverPerformance.js';

export const driverPerformanceRouter = Router();

driverPerformanceRouter.get('/', (req, res) => res.json(driverPerformance.report(req.query.period as string | undefined)));
