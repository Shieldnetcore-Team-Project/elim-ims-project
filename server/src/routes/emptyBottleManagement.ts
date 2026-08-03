import { Router } from 'express';
import * as emptyBottles from '../services/emptyBottleManagement.js';
import { safe } from '../lib/errors.js';

export const emptyBottleManagementRouter = Router();

emptyBottleManagementRouter.get('/summary', safe((_req, res) => {
  res.json(emptyBottles.conditionSummary());
}));

emptyBottleManagementRouter.get('/runs', safe((_req, res) => {
  res.json(emptyBottles.listRuns());
}));

emptyBottleManagementRouter.post('/runs', safe((req, res) => {
  const { quantityIssued, issuedBy, actor } = req.body ?? {};
  if (!quantityIssued || !issuedBy) {
    res.status(400).json({ error: 'quantityIssued and issuedBy are required' });
    return;
  }
  res.status(201).json(emptyBottles.startRun({ quantityIssued: Number(quantityIssued), issuedBy, actor }));
}));

emptyBottleManagementRouter.post('/runs/:id/reconcile', safe((req, res) => {
  const { damaged, leaking, finishedProduction, actor } = req.body ?? {};
  if (!actor) {
    res.status(400).json({ error: 'actor is required' });
    return;
  }
  res.json(emptyBottles.reconcileRun(req.params.id, {
    damaged: Number(damaged) || 0, leaking: Number(leaking) || 0, finishedProduction: Number(finishedProduction) || 0, actor,
  }));
}));

emptyBottleManagementRouter.post('/triage', safe((req, res) => {
  const { fromState, repairable, scrapped, actor } = req.body ?? {};
  if (fromState !== 'DAMAGED' && fromState !== 'LEAKING') {
    res.status(400).json({ error: `fromState must be DAMAGED or LEAKING` });
    return;
  }
  if (!actor) {
    res.status(400).json({ error: 'actor is required' });
    return;
  }
  emptyBottles.triageDefective({ fromState, repairable: Number(repairable) || 0, scrapped: Number(scrapped) || 0, actor });
  res.status(201).json({ ok: true });
}));

emptyBottleManagementRouter.post('/repair', safe((req, res) => {
  const { quantity, actor } = req.body ?? {};
  if (!quantity || !actor) {
    res.status(400).json({ error: 'quantity and actor are required' });
    return;
  }
  emptyBottles.completeRepair({ quantity: Number(quantity), actor });
  res.status(201).json({ ok: true });
}));
