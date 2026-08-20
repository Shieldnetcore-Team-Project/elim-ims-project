import { Router } from 'express';
import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import { safe } from '../lib/errors.js';
import * as inventory from '../services/inventory.js';
import * as procurement from '../services/procurement.js';
import * as sales from '../services/sales.js';
import * as fleet from '../services/fleet.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as peripheral from '../services/peripheral.js';

export const mastersRouter = Router();

mastersRouter.get('/items', (req, res) => {
  const type = req.query.type as Parameters<typeof inventory.listItems>[0];
  res.json(deletionRequests.filterDeleted('items', inventory.listItems(type)));
});

mastersRouter.get('/item-categories', (_req, res) => res.json(inventory.listCategories()));
mastersRouter.get('/employee-statuses', (_req, res) => res.json(peripheral.employeeStatusOptions()));
mastersRouter.get('/employees', (_req, res) => res.json(db.prepare('SELECT id, name, status FROM employees ORDER BY name').all()));

// Self-serve material creation — e.g. a manufacturer/grammage variant
// ("PET Preform 16g — Prima") with its own pieces-per-bag conversion.
mastersRouter.post('/items', safe((req, res) => {
  const { name, category, type, uom, reorderPoint, unitCost, manufacturerId, piecesPerBag } = req.body ?? {};
  if (!name || !category || !type) {
    res.status(400).json({ error: 'name, category and type are required' });
    return;
  }
  const prefix = type === 'FINISHED_GOOD' ? 'FG-' : 'RM-';
  const id = nextBusinessId('items', prefix, 2);
  inventory.createItem({
    id, name, category, type, uom: uom || 'unit',
    reorder_point: Number(reorderPoint) || 0, unit_cost: Number(unitCost) || 0,
    manufacturer_id: manufacturerId || null, pieces_per_bag: piecesPerBag ? Number(piecesPerBag) : null,
  });
  res.status(201).json(inventory.getItem(id));
}));

mastersRouter.get('/suppliers', (_req, res) => res.json(procurement.listSuppliers()));

mastersRouter.get('/suppliers/:id', (req, res) => {
  const supplier = procurement.getSupplier(req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Not found' });
  res.json(supplier);
});

// Self-serve manufacturer/supplier creation — needed so "+ New manufacturer"
// in Procurement doesn't require going through the seed script.
mastersRouter.post('/suppliers', safe((req, res) => {
  const { name, location } = req.body ?? {};
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  const id = nextBusinessId('suppliers', 'SUP-', 2);
  procurement.createSupplier({ id, name, location: location || null });
  res.status(201).json({ id, name, location: location || null });
}));
mastersRouter.get('/customers', (_req, res) => res.json(sales.listCustomers()));

// Self-serve customer creation — one of the three customer categories
// (RETAIL/MARKETER/DISTRIBUTOR) that drive different order workflow in
// services/sales.ts. Retail doesn't require a profile at all to sell to, but
// can still optionally have one (e.g. for a repeat walk-in worth naming).
mastersRouter.post('/customers', safe((req, res) => {
  const { name, location, phone, customerType } = req.body ?? {};
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  const type = ['RETAIL', 'MARKETER', 'DISTRIBUTOR'].includes(customerType) ? customerType : 'MARKETER';
  const id = nextBusinessId('customers', 'CUS-', 2);
  sales.createCustomer({ id, name, location: location || null, phone: phone || null, customer_type: type });
  res.status(201).json(sales.getCustomer(id));
}));
mastersRouter.get('/vehicles', (_req, res) => res.json(fleet.listVehicles()));
mastersRouter.post('/vehicles', safe((req, res) => {
  const { driver, status, odometer, plateNumber, vehicleType, category, acquisitionDate } = req.body ?? {};
  if (category && category !== 'COMMERCIAL' && category !== 'PRIVATE') {
    res.status(400).json({ error: 'category must be COMMERCIAL or PRIVATE' });
    return;
  }
  const id = nextBusinessId('vehicles', 'FLT-', 2);
  res.status(201).json(fleet.createVehicle({ id, driver: driver ?? null, status, odometer, plateNumber, vehicleType, category, acquisitionDate }));
}));

// Flat user rows (not the generic ModuleRow wrapper) — used for the sign-in-as
// picker and the Admin panel's user selector.
mastersRouter.get('/users', (_req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, status FROM users ORDER BY name').all() as { id: string }[];
  res.json(deletionRequests.filterDeleted('users', rows));
});
