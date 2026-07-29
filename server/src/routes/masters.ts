import { Router } from 'express';
import { db } from '../db/client.js';
import * as inventory from '../services/inventory.js';
import * as procurement from '../services/procurement.js';
import * as sales from '../services/sales.js';
import * as fleet from '../services/fleet.js';
import * as deletionRequests from '../services/deletionRequests.js';

export const mastersRouter = Router();

mastersRouter.get('/items', (req, res) => {
  const type = req.query.type as Parameters<typeof inventory.listItems>[0];
  res.json(deletionRequests.filterDeleted('items', inventory.listItems(type)));
});
mastersRouter.get('/suppliers', (_req, res) => res.json(procurement.listSuppliers()));
mastersRouter.get('/customers', (_req, res) => res.json(sales.listCustomers()));
mastersRouter.get('/vehicles', (_req, res) => res.json(fleet.listVehicles()));

// Flat user rows (not the generic ModuleRow wrapper) — used for the sign-in-as
// picker and the Admin panel's user selector.
mastersRouter.get('/users', (_req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, status FROM users ORDER BY name').all() as { id: string }[];
  res.json(deletionRequests.filterDeleted('users', rows));
});
