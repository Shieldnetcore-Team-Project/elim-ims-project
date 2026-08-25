import { Router } from 'express';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';
import { moduleByKey } from '../../../shared/src/moduleConfig.js';

export const deletionRequestsRouter = Router();

deletionRequestsRouter.get('/', safe(async (req, res) => {
  const status = req.query.status as 'PENDING' | 'APPROVED' | 'REJECTED' | undefined;
  res.json(await deletionRequests.list(status));
}));

deletionRequestsRouter.post('/', safe(async (req, res) => {
  const { entityType, entityId, entityLabel, requestedBy, reason } = req.body ?? {};
  if (!entityType || !entityId || !requestedBy || !reason) {
    res.status(400).json({ error: 'entityType, entityId, requestedBy and reason are required' });
    return;
  }
  if (moduleByKey(entityType)?.readOnly) {
    res.status(403).json({ error: 'Records in a read-only audit trail cannot be deleted' });
    return;
  }
  res.status(201).json(await deletionRequests.request({ entityType, entityId, entityLabel, requestedBy, reason }));
}));

deletionRequestsRouter.post('/:id/approve', safe(async (req, res) => {
  const { reviewedBy, note } = req.body ?? {};
  if (!reviewedBy) { res.status(400).json({ error: 'reviewedBy is required' }); return; }
  res.json(await deletionRequests.approve(req.params.id, reviewedBy, note));
}));

deletionRequestsRouter.post('/:id/reject', safe(async (req, res) => {
  const { reviewedBy, note } = req.body ?? {};
  if (!reviewedBy) { res.status(400).json({ error: 'reviewedBy is required' }); return; }
  res.json(await deletionRequests.reject(req.params.id, reviewedBy, note));
}));
