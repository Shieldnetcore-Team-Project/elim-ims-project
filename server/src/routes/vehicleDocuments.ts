import { Router } from 'express';
import * as vehicleDocuments from '../services/vehicleDocuments.js';
import { safe } from '../lib/errors.js';

export const vehicleDocumentsRouter = Router();

vehicleDocumentsRouter.get('/document-types', (req, res) => {
  const category = req.query.category as 'COMMERCIAL' | 'PRIVATE';
  if (category !== 'COMMERCIAL' && category !== 'PRIVATE') {
    res.status(400).json({ error: 'category must be COMMERCIAL or PRIVATE' });
    return;
  }
  res.json(vehicleDocuments.documentTypesFor(category));
});
vehicleDocumentsRouter.get('/notification-days', (_req, res) => res.json({ days: vehicleDocuments.notificationDays() }));
vehicleDocumentsRouter.get('/expiring', (req, res) => {
  const windowDays = req.query.windowDays ? Number(req.query.windowDays) : undefined;
  res.json(vehicleDocuments.upcomingExpiries(windowDays));
});
vehicleDocumentsRouter.get('/', (req, res) => res.json(vehicleDocuments.listDocuments(req.query.vehicleId as string | undefined)));
vehicleDocumentsRouter.post('/', safe((req, res) => {
  const { vehicleId, documentType, documentNumber, issueDate, expiryDate, notes, actor } = req.body ?? {};
  if (!vehicleId || !documentType || !actor) {
    res.status(400).json({ error: 'vehicleId, documentType and actor are required' });
    return;
  }
  res.status(201).json(vehicleDocuments.addDocument({ vehicleId, documentType, documentNumber, issueDate, expiryDate, notes, actor }));
}));
