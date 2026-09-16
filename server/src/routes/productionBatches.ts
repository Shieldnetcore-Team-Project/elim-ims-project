import { Router } from 'express';
import * as production from '../services/production.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const productionBatchesRouter = Router();

productionBatchesRouter.get('/', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('production_batches', await production.listBatches())); }));
productionBatchesRouter.get('/ready-to-package', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('production_batches', await production.readyToPackage())); }));

productionBatchesRouter.post('/', safe(async (req, res) => {
  const { productItemId, line, shift, operator, unitsActual, unitsTarget, waterTreatmentRunId } = req.body ?? {};
  if (!productItemId || !line || !shift || !operator || typeof unitsActual !== 'number') {
    res.status(400).json({ error: 'productItemId, line, shift, operator and unitsActual are required' });
    return;
  }
  res.status(201).json(await production.recordBatch({ productItemId, line, shift, operator, unitsActual, unitsTarget, waterTreatmentRunId }));
}));

productionBatchesRouter.post('/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireApproval(userId, 'warehouse-reverse', ['Warehouse Manager'], 'Warehouse reversals');
  res.json(await production.reverseBatch(req.params.id, { reason, actor: approver.name }));
}));

productionBatchesRouter.post('/:id/close', safe(async (req, res) => {
  const { rejectedQuantity, wastedQuantity, actor } = req.body ?? {};
  if (typeof rejectedQuantity !== 'number' || typeof wastedQuantity !== 'number' || !actor) {
    res.status(400).json({ error: 'rejectedQuantity, wastedQuantity and actor are required' });
    return;
  }
  res.json(await production.closeBatch(req.params.id, { rejectedQuantity, wastedQuantity, actor }));
}));
