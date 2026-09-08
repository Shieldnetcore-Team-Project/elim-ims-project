import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as assets from './assets.js';
import * as maintenance from './maintenance.js';
import * as fuelRecords from './fuelRecords.js';
import * as vehicleDocuments from './vehicleDocuments.js';
import * as maintenanceReports from './maintenanceReports.js';

beforeAll(async () => { await ensureMigrated(); });

async function makeVehicle(category: 'COMMERCIAL' | 'PRIVATE' = 'COMMERCIAL'): Promise<string> {
  const id = uniqueId('TST-VEH-');
  await db.prepare(`INSERT INTO vehicles (id, driver, status, category) VALUES (?,?,'ACTIVE',?)`).run(id, 'Test Driver', category);
  return id;
}

describe('maintenance reports (Section 40)', () => {
  it('lists all eight report lenses', async () => {
    expect(await maintenanceReports.reportTypes()).toEqual([
      'VEHICLE', 'GENERATOR', 'MACHINE', 'BUILDING', 'FUEL', 'SPARE_PARTS', 'UTILITIES', 'REGULATORY',
    ]);
  });

  it('Vehicle Maintenance report shows vehicle-referenced maintenance jobs', async () => {
    const vehicleId = await makeVehicle();
    await maintenance.recordExpense({ refType: 'VEHICLE', refId: vehicleId, category: 'Brake', amount: 12000, actor: 'Test' });
    const rows = await maintenanceReports.report('VEHICLE');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.report_type === 'VEHICLE')).toBe(true);
  });

  it('Generator/Machine/Building reports split asset maintenance by category', async () => {
    const generator = await assets.createAsset({ name: 'Genset A', category: 'Generators', actor: 'Test' });
    await maintenance.recordExpense({ refType: 'ASSET', refId: generator.id, category: 'Generator Maintenance', amount: 5000, actor: 'Test' });

    const machine = await assets.createAsset({ name: 'Bottling line', category: 'Machines', actor: 'Test' });
    await maintenance.recordExpense({ refType: 'ASSET', refId: machine.id, category: 'Machine Maintenance', amount: 7000, actor: 'Test' });

    const building = await assets.createAsset({ name: 'Warehouse roof', category: 'Building', actor: 'Test' });
    await maintenance.recordExpense({ refType: 'ASSET', refId: building.id, category: 'Building Maintenance', amount: 9000, actor: 'Test' });

    expect((await maintenanceReports.report('GENERATOR')).some(r => r.id && r.category === 'Generator Maintenance')).toBe(true);
    expect((await maintenanceReports.report('MACHINE')).some(r => r.category === 'Machine Maintenance')).toBe(true);
    expect((await maintenanceReports.report('BUILDING')).some(r => r.category === 'Building Maintenance')).toBe(true);
    // Cross-check they don't leak into each other's report.
    expect((await maintenanceReports.report('GENERATOR')).some(r => r.category === 'Machine Maintenance')).toBe(false);
  });

  it('Fuel report reflects fuel_records with vehicle plate numbers', async () => {
    const vehicleId = await makeVehicle();
    await db.prepare(`UPDATE vehicles SET plate_number = ? WHERE id = ?`).run('ABJ-999-KJA', vehicleId);
    await fuelRecords.recordFuel({ vehicleId, quantity: 40, unitCost: 950, actor: 'Test' });
    const rows = await maintenanceReports.report('FUEL');
    const row = rows.find(r => r.ref_label === 'ABJ-999-KJA')!;
    expect(row.amount).toBe(38000);
  });

  it('Regulatory Documentation report reflects vehicle_documents', async () => {
    const vehicleId = await makeVehicle('PRIVATE');
    await vehicleDocuments.addDocument({ vehicleId, documentType: 'Insurance', expiryDate: '2027-01-01', actor: 'Test' });
    const rows = await maintenanceReports.report('REGULATORY');
    expect(rows.some(r => r.category === 'Insurance')).toBe(true);
  });

  it('date range filters maintenance report rows by service date', async () => {
    const vehicleId = await makeVehicle();
    await maintenance.recordExpense({ refType: 'VEHICLE', refId: vehicleId, category: 'Brake', amount: 1000, serviceDate: '2020-05-01', actor: 'Test' });
    const inRange = await maintenanceReports.report('VEHICLE', { from: '2020-01-01', to: '2020-12-31' });
    expect(inRange.some(r => r.amount === 1000 && r.date === '2020-05-01')).toBe(true);
    const outOfRange = await maintenanceReports.report('VEHICLE', { from: '2021-01-01', to: '2021-12-31' });
    expect(outOfRange.some(r => r.amount === 1000 && r.date === '2020-05-01')).toBe(false);
  });
});
