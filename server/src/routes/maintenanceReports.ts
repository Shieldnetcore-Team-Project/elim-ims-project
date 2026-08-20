import { Router } from 'express';
import * as maintenanceReports from '../services/maintenanceReports.js';

export const maintenanceReportsRouter = Router();

maintenanceReportsRouter.get('/types', (_req, res) => res.json(maintenanceReports.reportTypes()));

maintenanceReportsRouter.get('/', (req, res) => {
  const type = req.query.type as maintenanceReports.MaintenanceReportType;
  if (!maintenanceReports.reportTypes().includes(type)) {
    res.status(400).json({ error: `type must be one of ${maintenanceReports.reportTypes().join(', ')}` });
    return;
  }
  const { from, to } = req.query;
  const range = typeof from === 'string' && typeof to === 'string' && from && to ? { from, to } : undefined;
  res.json(maintenanceReports.report(type, range));
});
