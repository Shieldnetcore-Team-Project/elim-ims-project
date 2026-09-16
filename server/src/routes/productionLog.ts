import { Router } from 'express';
import * as productionLog from '../services/productionLog.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const productionLogRouter = Router();

productionLogRouter.get('/', safe(async (_req, res) => {
  res.json(await deletionRequests.filterDeleted('production_log_entries', await productionLog.listEntries()));
}));

productionLogRouter.post('/', safe(async (req, res) => {
  const { recordedBy, note, items } = req.body ?? {};
  if (!recordedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'recordedBy and a non-empty items array are required' });
    return;
  }
  const lines = items.map((l: { itemId?: string; quantity?: unknown }) => ({ itemId: l.itemId ?? '', quantity: Number(l.quantity) }));
  if (lines.some(l => !l.itemId || !Number.isFinite(l.quantity))) {
    res.status(400).json({ error: 'each item line needs an itemId and a numeric quantity' });
    return;
  }
  res.status(201).json(await productionLog.recordEntry({ recordedBy, note, items: lines }));
}));

productionLogRouter.post('/:id/reverse', safe(async (req, res) => {
  const { reason, userId } = req.body ?? {};
  const approver = await accessControl.requireApproval(userId, 'warehouse-reverse', ['Warehouse Manager'], 'Warehouse reversals');
  res.json(await productionLog.reverseEntry(req.params.id, { reason, actor: approver.name }));
}));
