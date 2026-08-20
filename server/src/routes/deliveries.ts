import { Router } from 'express';
import * as fleet from '../services/fleet.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const deliveriesRouter = Router();

deliveriesRouter.get('/', (_req, res) => res.json(deletionRequests.filterDeleted('delivery_runs', fleet.listRuns())));
deliveriesRouter.get('/pending-dispatch', (_req, res) => res.json(deletionRequests.filterDeleted('sales', fleet.pendingDispatch())));

deliveriesRouter.post('/', safe((req, res) => {
  const { salesId, vehicleId, driver, route } = req.body ?? {};
  if (!salesId || !vehicleId || !driver || !route) {
    res.status(400).json({ error: 'salesId, vehicleId, driver and route are required' });
    return;
  }
  res.status(201).json(fleet.dispatchDelivery({ salesId, vehicleId, driver, route }));
}));

deliveriesRouter.post('/:id/start-transit', safe((req, res) => {
  const { actor } = req.body ?? {};
  if (!actor) { res.status(400).json({ error: 'actor is required' }); return; }
  res.json(fleet.startTransit(req.params.id, actor));
}));

deliveriesRouter.post('/:id/delivered', safe((req, res) => {
  const { authorizedByUserId, deliveredBy, actor } = req.body ?? {};
  if (!authorizedByUserId || !deliveredBy) {
    res.status(400).json({ error: 'authorizedByUserId and deliveredBy are required' });
    return;
  }
  res.json(fleet.markDelivered(req.params.id, { authorizedByUserId, deliveredBy, actor }));
}));

deliveriesRouter.post('/:id/cancel', safe((req, res) => {
  const { reason, actor } = req.body ?? {};
  if (!reason || !actor) { res.status(400).json({ error: 'reason and actor are required' }); return; }
  res.json(fleet.cancelDelivery(req.params.id, { reason, actor }));
}));

deliveriesRouter.post('/:id/return', safe((req, res) => {
  const { reason, actor } = req.body ?? {};
  if (!reason || !actor) { res.status(400).json({ error: 'reason and actor are required' }); return; }
  res.json(fleet.returnDelivery(req.params.id, { reason, actor }));
}));
