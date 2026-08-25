import { Router } from 'express';
import * as marketerReconciliation from '../services/marketerReconciliation.js';
import { safe } from '../lib/errors.js';

export const marketerReconciliationRouter = Router();

marketerReconciliationRouter.get('/', safe(async (req, res) => {
  const marketerId = typeof req.query.marketerId === 'string' ? req.query.marketerId : undefined;
  res.json(await marketerReconciliation.reconciliation(marketerId));
}));
