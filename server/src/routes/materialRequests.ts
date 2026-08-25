import { Router } from 'express';
import * as materialRequests from '../services/materialRequests.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const materialRequestsRouter = Router();

materialRequestsRouter.get('/', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('material_requests', await materialRequests.listRequests())); }));

materialRequestsRouter.get('/:id', safe(async (req, res) => {
  const request = await materialRequests.getRequest(req.params.id);
  if (!request) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...request, items: await materialRequests.listRequestItems(req.params.id) });
}));

materialRequestsRouter.post('/', safe(async (req, res) => {
  const { requestedBy, department, neededBy, items } = req.body ?? {};
  if (!requestedBy || !department || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'requestedBy, department and at least one item are required' });
    return;
  }
  res.status(201).json(await materialRequests.createRequest({ requestedBy, department, neededBy, items }));
}));

materialRequestsRouter.post('/:id/issue', safe(async (req, res) => {
  res.json(await materialRequests.approveAndIssue(req.params.id, req.body?.actor));
}));

materialRequestsRouter.post('/:id/reject', safe(async (req, res) => {
  await materialRequests.reject(req.params.id, req.body?.actor);
  res.json({ ok: true });
}));

materialRequestsRouter.post('/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireRole(userId, ['Warehouse Manager']);
  res.json(await materialRequests.reverseIssue(req.params.id, { reason, actor: approver.name }));
}));
