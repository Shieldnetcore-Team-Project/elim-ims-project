import { Router } from 'express';
import * as maintenanceReports from '../services/maintenanceReports.js';
import { safe } from '../lib/errors.js';

export const maintenanceReportsRouter = Router();

maintenanceReportsRouter.get('/types', safe(async (_req, res) => { res.json(maintenanceReports.reportTypes()); }));

maintenanceReportsRouter.get('/', safe(async (req, res) => {
  const type = req.query.type as maintenanceReports.MaintenanceReportType;
  if (!maintenanceReports.reportTypes().includes(type)) {
    res.status(400).json({ error: `type must be one of ${maintenanceReports.reportTypes().join(', ')}` });
    return;
  }
  const { from, to } = req.query;
  const range = typeof from === 'string' && typeof to === 'string' && from && to ? { from, to } : undefined;
  res.json(await maintenanceReports.report(type, range));
}));
