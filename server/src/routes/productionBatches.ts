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
