import { Router } from 'express';
import * as assets from '../services/assets.js';
import { safe } from '../lib/errors.js';

export const assetsRouter = Router();

assetsRouter.get('/categories', (_req, res) => res.json(assets.listCategories()));
assetsRouter.get('/', (_req, res) => res.json(assets.listAssets()));
assetsRouter.get('/:id', (req, res) => {
  const asset = assets.getAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  res.json(asset);
});
assetsRouter.post('/', safe((req, res) => {
  const { name, category, serialNumber, location, assignedDepartment, serviceIntervalDays, notes, actor } = req.body ?? {};
  if (!name || !actor) {
    res.status(400).json({ error: 'name and actor are required' });
    return;
  }
  res.status(201).json(assets.createAsset({ name, category, serialNumber, location, assignedDepartment, serviceIntervalDays, notes, actor }));
}));
assetsRouter.put('/:id', safe((req, res) => {
  const { location, assignedDepartment, serviceIntervalDays, notes, status, actor } = req.body ?? {};
  if (!actor) {
    res.status(400).json({ error: 'actor is required' });
    return;
  }
  res.json(assets.updateAsset(req.params.id, { location, assignedDepartment, serviceIntervalDays, notes, status }, actor));
}));
