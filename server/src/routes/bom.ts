import { Router } from 'express';
import * as bom from '../services/bom.js';
import { safe } from '../lib/errors.js';

export const bomRouter = Router();

bomRouter.get('/:productItemId', safe(async (req, res) => {
  res.json(await bom.getComponents(req.params.productItemId));
}));

bomRouter.put('/:productItemId', safe(async (req, res) => {
  const { components, actor } = req.body ?? {};
  if (!Array.isArray(components)) {
    res.status(400).json({ error: 'components must be an array of {itemId, qtyPerUnit}' });
    return;
  }
  res.json(await bom.setComponents(req.params.productItemId, components, actor ?? 'System Administrator'));
}));
