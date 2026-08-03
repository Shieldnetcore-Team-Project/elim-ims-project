import { Router } from 'express';
import * as bom from '../services/bom.js';
import { safe } from '../lib/errors.js';

export const bomRouter = Router();

bomRouter.get('/:productItemId', (req, res) => {
  res.json(bom.getComponents(req.params.productItemId));
});

bomRouter.put('/:productItemId', safe((req, res) => {
  const { components, actor } = req.body ?? {};
  if (!Array.isArray(components)) {
    res.status(400).json({ error: 'components must be an array of {itemId, qtyPerUnit}' });
    return;
  }
  res.json(bom.setComponents(req.params.productItemId, components, actor ?? 'System Administrator'));
}));
