import { Router } from 'express';
import * as fuelRecords from '../services/fuelRecords.js';
import { safe } from '../lib/errors.js';

export const fuelRecordsRouter = Router();

fuelRecordsRouter.get('/', safe(async (req, res) => { res.json(await fuelRecords.listRecords(req.query.vehicleId as string | undefined)); }));
fuelRecordsRouter.get('/report', safe(async (req, res) => {
  const groupBy = (req.query.groupBy as fuelRecords.FuelGroupBy) ?? 'vehicle';
  res.json(await fuelRecords.report(groupBy));
}));
fuelRecordsRouter.post('/', safe(async (req, res) => {
  const { vehicleId, driver, department, fuelDate, fuelType, quantity, unitCost, odometer, vendor, receiptReference, remarks, method, actor } = req.body ?? {};
  if (!vehicleId || typeof quantity !== 'number' || typeof unitCost !== 'number' || !actor) {
    res.status(400).json({ error: 'vehicleId, quantity, unitCost and actor are required' });
    return;
  }
  res.status(201).json(await fuelRecords.recordFuel({ vehicleId, driver, department, fuelDate, fuelType, quantity, unitCost, odometer, vendor, receiptReference, remarks, method, actor }));
}));
