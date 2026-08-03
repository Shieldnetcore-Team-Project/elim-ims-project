import { Router } from 'express';
import * as materialRequests from '../services/materialRequests.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const materialRequestsRouter = Router();

materialRequestsRouter.get('/', (_req, res) => res.json(deletionRequests.filterDeleted('material_requests', materialRequests.listRequests())));

materialRequestsRouter.get('/:id', (req, res) => {
  const request = materialRequests.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  res.json({ ...request, items: materialRequests.listRequestItems(req.params.id) });
});

materialRequestsRouter.post('/', safe((req, res) => {
  const { requestedBy, department, neededBy, items } = req.body ?? {};
  if (!requestedBy || !department || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'requestedBy, department and at least one item are required' });
    return;
  }
  res.status(201).json(materialRequests.createRequest({ requestedBy, department, neededBy, items }));
}));

materialRequestsRouter.post('/:id/issue', safe((req, res) => {
  res.json(materialRequests.approveAndIssue(req.params.id, req.body?.actor));
}));

materialRequestsRouter.post('/:id/reject', safe((req, res) => {
  materialRequests.reject(req.params.id, req.body?.actor);
  res.json({ ok: true });
}));

materialRequestsRouter.post('/:id/reverse', safe((req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = accessControl.requireRole(userId, ['Warehouse Manager']);
  res.json(materialRequests.reverseIssue(req.params.id, { reason, actor: approver.name }));
}));
