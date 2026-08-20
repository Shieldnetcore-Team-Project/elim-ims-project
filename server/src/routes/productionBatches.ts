import { Router } from 'express';
import * as production from '../services/production.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const productionBatchesRouter = Router();

productionBatchesRouter.get('/', (_req, res) => res.json(deletionRequests.filterDeleted('production_batches', production.listBatches())));
productionBatchesRouter.get('/ready-to-package', (_req, res) => res.json(deletionRequests.filterDeleted('production_batches', production.readyToPackage())));

productionBatchesRouter.post('/', safe((req, res) => {
  const { productItemId, line, shift, operator, unitsActual, unitsTarget, waterTreatmentRunId } = req.body ?? {};
  if (!productItemId || !line || !shift || !operator || typeof unitsActual !== 'number') {
    res.status(400).json({ error: 'productItemId, line, shift, operator and unitsActual are required' });
    return;
  }
  res.status(201).json(production.recordBatch({ productItemId, line, shift, operator, unitsActual, unitsTarget, waterTreatmentRunId }));
}));

productionBatchesRouter.post('/:id/reverse', safe((req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = accessControl.requireRole(userId, ['Warehouse Manager']);
  res.json(production.reverseBatch(req.params.id, { reason, actor: approver.name }));
}));

productionBatchesRouter.post('/:id/close', safe((req, res) => {
  const { rejectedQuantity, wastedQuantity, actor } = req.body ?? {};
  if (typeof rejectedQuantity !== 'number' || typeof wastedQuantity !== 'number' || !actor) {
    res.status(400).json({ error: 'rejectedQuantity, wastedQuantity and actor are required' });
    return;
  }
  res.json(production.closeBatch(req.params.id, { rejectedQuantity, wastedQuantity, actor }));
}));
