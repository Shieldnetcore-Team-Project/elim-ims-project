import { Router } from 'express';
import * as maintenance from '../services/maintenance.js';
import { safe } from '../lib/errors.js';

export const maintenanceRouter = Router();

maintenanceRouter.get('/categories', (_req, res) => res.json(maintenance.listCategories()));
maintenanceRouter.get('/', (req, res) => {
  const refType = req.query.refType as 'ASSET' | 'VEHICLE' | undefined;
  const refId = req.query.refId as string | undefined;
  res.json(maintenance.listRecords({ refType, refId }));
});
maintenanceRouter.get('/:id', (req, res) => {
  const record = maintenance.getRecord(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});
maintenanceRouter.post('/', safe((req, res) => {
  const { refType, refId, category, description, vendor, amount, serviceDate, invoiceReference, performedBy, approvedBy, nextDueDate, remarks, method, actor } = req.body ?? {};
  if (!refType || !refId || !category || typeof amount !== 'number' || !actor) {
    res.status(400).json({ error: 'refType, refId, category, amount and actor are required' });
    return;
  }
  res.status(201).json(maintenance.recordExpense({ refType, refId, category, description, vendor, amount, serviceDate, invoiceReference, performedBy, approvedBy, nextDueDate, remarks, method, actor }));
}));
