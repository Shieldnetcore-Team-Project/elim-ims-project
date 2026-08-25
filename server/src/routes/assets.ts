import { Router } from 'express';
import * as assets from '../services/assets.js';
import { safe } from '../lib/errors.js';

export const assetsRouter = Router();

assetsRouter.get('/categories', safe(async (_req, res) => { res.json(await assets.listCategories()); }));
assetsRouter.get('/', safe(async (_req, res) => { res.json(await assets.listAssets()); }));
assetsRouter.get('/:id', safe(async (req, res) => {
  const asset = await assets.getAsset(req.params.id);
  if (!asset) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(asset);
}));
assetsRouter.post('/', safe(async (req, res) => {
  const { name, category, serialNumber, location, assignedDepartment, serviceIntervalDays, notes, actor } = req.body ?? {};
  if (!name || !actor) {
    res.status(400).json({ error: 'name and actor are required' });
    return;
  }
  res.status(201).json(await assets.createAsset({ name, category, serialNumber, location, assignedDepartment, serviceIntervalDays, notes, actor }));
}));
assetsRouter.put('/:id', safe(async (req, res) => {
  const { location, assignedDepartment, serviceIntervalDays, notes, status, actor } = req.body ?? {};
  if (!actor) {
    res.status(400).json({ error: 'actor is required' });
    return;
  }
  res.json(await assets.updateAsset(req.params.id, { location, assignedDepartment, serviceIntervalDays, notes, status }, actor));
}));
