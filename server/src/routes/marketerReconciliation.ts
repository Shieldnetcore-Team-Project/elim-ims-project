import { Router } from 'express';
import * as marketerReconciliation from '../services/marketerReconciliation.js';

export const marketerReconciliationRouter = Router();

marketerReconciliationRouter.get('/', (req, res) => {
  const marketerId = typeof req.query.marketerId === 'string' ? req.query.marketerId : undefined;
  res.json(marketerReconciliation.reconciliation(marketerId));
});
