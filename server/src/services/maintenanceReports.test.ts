import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as assets from './assets.js';
import * as maintenance from './maintenance.js';
import * as fuelRecords from './fuelRecords.js';
import * as vehicleDocuments from './vehicleDocuments.js';
import * as maintenanceReports from './maintenanceReports.js';

beforeAll(() => ensureMigrated());

function makeVehicle(category: 'COMMERCIAL' | 'PRIVATE' = 'COMMERCIAL'): string {
  const id = uniqueId('TST-VEH-');
  db.prepare(`INSERT INTO vehicles (id, driver, status, category) VALUES (?,?,'ACTIVE',?)`).run(id, 'Test Driver', category);
  return id;
}

describe('maintenance reports (Section 40)', () => {
  it('lists all eight report lenses', () => {
    expect(maintenanceReports.reportTypes()).toEqual([
      'VEHICLE', 'GENERATOR', 'MACHINE', 'BUILDING', 'FUEL', 'SPARE_PARTS', 'UTILITIES', 'REGULATORY',
    ]);
  });

  it('Vehicle Maintenance report shows vehicle-referenced maintenance jobs', () => {
    const vehicleId = makeVehicle();
    maintenance.recordExpense({ refType: 'VEHICLE', refId: vehicleId, category: 'Brake', amount: 12000, actor: 'Test' });
    const rows = maintenanceReports.report('VEHICLE');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.report_type === 'VEHICLE')).toBe(true);
  });

  it('Generator/Machine/Building reports split asset maintenance by category', () => {
    const generator = assets.createAsset({ name: 'Genset A', category: 'Generators', actor: 'Test' });
    maintenance.recordExpense({ refType: 'ASSET', refId: generator.id, category: 'Generator Maintenance', amount: 5000, actor: 'Test' });

    const machine = assets.createAsset({ name: 'Bottling line', category: 'Machines', actor: 'Test' });
    maintenance.recordExpense({ refType: 'ASSET', refId: machine.id, category: 'Machine Maintenance', amount: 7000, actor: 'Test' });

    const building = assets.createAsset({ name: 'Warehouse roof', category: 'Building', actor: 'Test' });
    maintenance.recordExpense({ refType: 'ASSET', refId: building.id, category: 'Building Maintenance', amount: 9000, actor: 'Test' });

    expect(maintenanceReports.report('GENERATOR').some(r => r.id && r.category === 'Generator Maintenance')).toBe(true);
    expect(maintenanceReports.report('MACHINE').some(r => r.category === 'Machine Maintenance')).toBe(true);
    expect(maintenanceReports.report('BUILDING').some(r => r.category === 'Building Maintenance')).toBe(true);
    // Cross-check they don't leak into each other's report.
    expect(maintenanceReports.report('GENERATOR').some(r => r.category === 'Machine Maintenance')).toBe(false);
  });

  it('Fuel report reflects fuel_records with vehicle plate numbers', () => {
    const vehicleId = makeVehicle();
    db.prepare(`UPDATE vehicles SET plate_number = ? WHERE id = ?`).run('ABJ-999-KJA', vehicleId);
    fuelRecords.recordFuel({ vehicleId, quantity: 40, unitCost: 950, actor: 'Test' });
    const rows = maintenanceReports.report('FUEL');
    const row = rows.find(r => r.ref_label === 'ABJ-999-KJA')!;
    expect(row.amount).toBe(38000);
  });

  it('Regulatory Documentation report reflects vehicle_documents', () => {
    const vehicleId = makeVehicle('PRIVATE');
    vehicleDocuments.addDocument({ vehicleId, documentType: 'Insurance', expiryDate: '2027-01-01', actor: 'Test' });
    const rows = maintenanceReports.report('REGULATORY');
    expect(rows.some(r => r.category === 'Insurance')).toBe(true);
  });

  it('date range filters maintenance report rows by service date', () => {
    const vehicleId = makeVehicle();
    maintenance.recordExpense({ refType: 'VEHICLE', refId: vehicleId, category: 'Brake', amount: 1000, serviceDate: '2020-05-01', actor: 'Test' });
    const inRange = maintenanceReports.report('VEHICLE', { from: '2020-01-01', to: '2020-12-31' });
    expect(inRange.some(r => r.amount === 1000 && r.date === '2020-05-01')).toBe(true);
    const outOfRange = maintenanceReports.report('VEHICLE', { from: '2021-01-01', to: '2021-12-31' });
    expect(outOfRange.some(r => r.amount === 1000 && r.date === '2020-05-01')).toBe(false);
  });
});
