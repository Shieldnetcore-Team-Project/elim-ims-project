import { Router } from 'express';
import * as fleet from '../services/fleet.js';
import * as deletionRequests from '../services/deletionRequests.js';
import { safe } from '../lib/errors.js';

export const deliveriesRouter = Router();

deliveriesRouter.get('/', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('delivery_runs', await fleet.listRuns())); }));
deliveriesRouter.get('/pending-dispatch', safe(async (_req, res) => { res.json(await deletionRequests.filterDeleted('sales', await fleet.pendingDispatch())); }));

deliveriesRouter.post('/', safe(async (req, res) => {
  const { salesId, vehicleId, driver, route } = req.body ?? {};
  if (!salesId || !vehicleId || !driver || !route) {
    res.status(400).json({ error: 'salesId, vehicleId, driver and route are required' });
    return;
  }
  res.status(201).json(await fleet.dispatchDelivery({ salesId, vehicleId, driver, route }));
}));

deliveriesRouter.post('/:id/start-transit', safe(async (req, res) => {
  const { actor } = req.body ?? {};
  if (!actor) { res.status(400).json({ error: 'actor is required' }); return; }
  res.json(await fleet.startTransit(req.params.id, actor));
}));

deliveriesRouter.post('/:id/delivered', safe(async (req, res) => {
  const { authorizedByUserId, deliveredBy, actor } = req.body ?? {};
  if (!authorizedByUserId || !deliveredBy) {
    res.status(400).json({ error: 'authorizedByUserId and deliveredBy are required' });
    return;
  }
  res.json(await fleet.markDelivered(req.params.id, { authorizedByUserId, deliveredBy, actor }));
}));

deliveriesRouter.post('/:id/cancel', safe(async (req, res) => {
  const { reason, actor } = req.body ?? {};
  if (!reason || !actor) { res.status(400).json({ error: 'reason and actor are required' }); return; }
  res.json(await fleet.cancelDelivery(req.params.id, { reason, actor }));
}));

deliveriesRouter.post('/:id/return', safe(async (req, res) => {
  const { reason, actor } = req.body ?? {};
  if (!reason || !actor) { res.status(400).json({ error: 'reason and actor are required' }); return; }
  res.json(await fleet.returnDelivery(req.params.id, { reason, actor }));
}));
