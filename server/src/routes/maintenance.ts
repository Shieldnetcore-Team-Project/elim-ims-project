import { Router } from 'express';
import * as maintenance from '../services/maintenance.js';
import { safe } from '../lib/errors.js';

export const maintenanceRouter = Router();

maintenanceRouter.get('/categories', safe(async (_req, res) => { res.json(await maintenance.listCategories()); }));
maintenanceRouter.get('/', safe(async (req, res) => {
  const refType = req.query.refType as 'ASSET' | 'VEHICLE' | undefined;
  const refId = req.query.refId as string | undefined;
  res.json(await maintenance.listRecords({ refType, refId }));
}));
maintenanceRouter.get('/:id', safe(async (req, res) => {
  const record = await maintenance.getRecord(req.params.id);
  if (!record) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(record);
}));
maintenanceRouter.post('/', safe(async (req, res) => {
  const { refType, refId, category, description, vendor, amount, serviceDate, invoiceReference, performedBy, approvedBy, nextDueDate, remarks, method, actor } = req.body ?? {};
  if (!refType || !refId || !category || typeof amount !== 'number' || !actor) {
    res.status(400).json({ error: 'refType, refId, category, amount and actor are required' });
    return;
  }
  res.status(201).json(await maintenance.recordExpense({ refType, refId, category, description, vendor, amount, serviceDate, invoiceReference, performedBy, approvedBy, nextDueDate, remarks, method, actor }));
}));
