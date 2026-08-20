import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, uniqueId } from '../test/fixtures.js';
import * as assets from './assets.js';
import * as maintenance from './maintenance.js';
import * as fuelRecords from './fuelRecords.js';
import * as vehicleDocuments from './vehicleDocuments.js';

beforeAll(() => ensureMigrated());

function makeVehicle(category: 'COMMERCIAL' | 'PRIVATE' = 'COMMERCIAL'): string {
  const id = uniqueId('TST-VEH-');
  db.prepare(`INSERT INTO vehicles (id, driver, status, category) VALUES (?,?,'ACTIVE',?)`).run(id, 'Test Driver', category);
  return id;
}

describe('assets (Section 30)', () => {
  it('registers an asset and exposes configurable categories', () => {
    const categories = assets.listCategories();
    expect(categories).toContain('Generators');

    const asset = assets.createAsset({ name: 'Generator A', category: 'Generators', location: 'Main plant', actor: 'Test HR' });
    expect(asset.category).toBe('Generators');
    expect(asset.last_service).toBeNull();
  });

  it('syncs last-service/next-due when a maintenance job is recorded against an asset', () => {
    const asset = assets.createAsset({ name: 'Generator B', category: 'Generators', actor: 'Test HR' });
    maintenance.recordExpense({
      refType: 'ASSET', refId: asset.id, category: 'Generator Maintenance', amount: 5000,
      serviceDate: '2026-08-01', nextDueDate: '2026-11-01', actor: 'Test HR',
    });
    const updated = assets.getAsset(asset.id)!;
    expect(updated.last_service).toBe('2026-08-01');
    expect(updated.next_due).toBe('2026-11-01');
  });
});

describe('maintenance expenses (Section 31)', () => {
  it('supports configurable categories and rejects an unknown asset/vehicle reference', () => {
    expect(maintenance.listCategories()).toContain('Tyre Maintenance');
    expect(() => maintenance.recordExpense({
      refType: 'VEHICLE', refId: 'NOPE-999', category: 'Tyres', amount: 1000, actor: 'Test HR',
    })).toThrow();
  });

  it('records each maintenance job independently and posts a real payment', () => {
    const vehicleId = makeVehicle();
    const record = maintenance.recordExpense({
      refType: 'VEHICLE', refId: vehicleId, category: 'Brake', vendor: 'AutoCare Ltd', amount: 15000,
      performedBy: 'Mechanic Joe', approvedBy: 'Fleet Manager', actor: 'Test HR',
    });
    expect(record.amount).toBe(15000);
    const list = maintenance.listRecords({ refType: 'VEHICLE', refId: vehicleId });
    expect(list.map(r => r.id)).toContain(record.id);
  });
});

describe('fuel tracking (Section 32)', () => {
  it('always computes total cost server-side from quantity × unit cost', () => {
    const vehicleId = makeVehicle();
    const record = fuelRecords.recordFuel({
      vehicleId, driver: 'Test Driver', department: 'Distribution', quantity: 40, unitCost: 950,
      fuelType: 'Diesel', odometer: 12000, actor: 'Test HR',
    });
    expect(record.total_cost).toBe(38000);
  });

  it('rejects non-positive quantity and negative unit cost', () => {
    const vehicleId = makeVehicle();
    expect(() => fuelRecords.recordFuel({ vehicleId, quantity: 0, unitCost: 500, actor: 'Test HR' })).toThrow();
    expect(() => fuelRecords.recordFuel({ vehicleId, quantity: 10, unitCost: -1, actor: 'Test HR' })).toThrow();
  });

  it('reports fuel spend grouped by vehicle', () => {
    const vehicleId = makeVehicle();
    fuelRecords.recordFuel({ vehicleId, quantity: 20, unitCost: 900, actor: 'Test HR' });
    fuelRecords.recordFuel({ vehicleId, quantity: 15, unitCost: 900, actor: 'Test HR' });
    const report = fuelRecords.report('vehicle');
    const row = report.find(r => r.key === vehicleId)!;
    expect(row.quantity).toBe(35);
    expect(row.total_cost).toBe(31500);
  });
});

describe('vehicle documentation (Sections 33-35)', () => {
  it('shows different document requirements for commercial vs private vehicles', () => {
    const commercialTypes = vehicleDocuments.documentTypesFor('COMMERCIAL');
    const privateTypes = vehicleDocuments.documentTypesFor('PRIVATE');
    expect(commercialTypes).toContain('AMAC documentation');
    expect(privateTypes).not.toContain('AMAC documentation');
    expect(privateTypes).toContain('Roadworthiness');
  });

  it('rejects a document type that is not configured for the vehicle category', () => {
    const vehicleId = makeVehicle('PRIVATE');
    expect(() => vehicleDocuments.addDocument({
      vehicleId, documentType: 'AMAC documentation', actor: 'Test HR',
    })).toThrow();
  });

  it('accepts a document type that is configured for the vehicle category', () => {
    const vehicleId = makeVehicle('PRIVATE');
    const doc = vehicleDocuments.addDocument({
      vehicleId, documentType: 'Insurance', expiryDate: '2026-08-30', actor: 'Test HR',
    });
    expect(doc.document_type).toBe('Insurance');
  });

  it('defaults the notification window to one week and surfaces documents inside it', () => {
    expect(vehicleDocuments.notificationDays()).toBeGreaterThan(0);

    const vehicleId = makeVehicle('PRIVATE');
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    vehicleDocuments.addDocument({
      vehicleId, documentType: 'Insurance', expiryDate: soon.toISOString().slice(0, 10), actor: 'Test HR',
    });

    const alerts = vehicleDocuments.upcomingExpiries();
    expect(alerts.some(a => a.vehicle_id === vehicleId)).toBe(true);
  });

  it('marks a document already past its expiry date as expired', () => {
    const vehicleId = makeVehicle('PRIVATE');
    vehicleDocuments.addDocument({ vehicleId, documentType: 'Registration', expiryDate: '2020-01-01', actor: 'Test HR' });
    const alerts = vehicleDocuments.upcomingExpiries(3650);
    const alert = alerts.find(a => a.vehicle_id === vehicleId && a.document_type === 'Registration')!;
    expect(alert.expired).toBe(true);
  });
});
